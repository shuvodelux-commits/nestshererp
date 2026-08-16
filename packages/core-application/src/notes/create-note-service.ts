import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type { NoteResponse } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import { Money, Ulid } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { Outbox } from '../ports/outbox';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { EntryMode, Note, NoteRepository } from './note-repository';

/**
 * ============================================================================
 * THE TEMPLATE FOR EVERY MUTATING USE CASE IN SherERP. COPY THIS SHAPE.
 * ============================================================================
 *
 * `Note` is a deliberately trivial document — it exists to demonstrate the
 * canonical write path (R-D, SRS 2.3) with nothing else in the way. A real use
 * case (CreateSale, RecordPurchase, ReceivePayment) differs only in steps 5–8.
 *
 * All ten steps run inside ONE transaction. All ten, or the change is rejected:
 *
 *    1  resolve TenantContext          — arrives in the command, from the token
 *    2  permission check               — HERE, not only in the HTTP guard
 *    3  idempotency check              — by operation_id
 *    4  PeriodGuard.assertOpen         — on business_date
 *    5  load aggregates
 *    6  domain invariants
 *    7  persist changes
 *    8  post journal + stock movements — none for a note; see the note at step 8
 *    9  audit event + outbox record
 *   10  commit                         — implicit when the callback returns
 *
 * Rules this file exists to demonstrate:
 *   - tenant_id is never read from the command payload, only from TenantContext
 *   - money is an integer minor unit through Money, never a float
 *   - ids are ULIDs generated here, never by the database
 *   - time comes from the Clock port, never from `new Date()`
 *   - the outbox write stays even though nothing reads it until Phase 12 (D7)
 */
export interface CreateNoteCommand {
  readonly ctx: TenantContext;
  /** Client-generated ULID, reused verbatim on retry (§5.26). */
  readonly operationId: string;
  readonly title: string;
  /** Integer poisha. */
  readonly amountMinor: number;
  /** Tenant-local YYYY-MM-DD. */
  readonly businessDate: string;
  /** API | DAYBOOK | SYNC | MCP (§5.22). */
  readonly source: string;
}

const DOC_TYPE = 'NOTE';
const ENTITY_TYPE = 'note';

export class CreateNoteService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly idempotency: IdempotencyStore,
    private readonly periodGuard: PeriodGuard,
    private readonly notes: NoteRepository,
    private readonly numbering: NumberingService,
    private readonly audit: AuditWriter,
    private readonly outbox: Outbox,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateNoteCommand): Promise<NoteResponse> {
    // 1 — TenantContext. Built by the caller from the verified token; the
    //     payload never carries a tenant id (R-C4).
    const { ctx } = command;
    const fingerprint = fingerprintOf(command);

    // 10 — one transaction wraps every step below; it commits when this
    //      callback returns and rolls back entirely if anything throws.
    return this.uow.run(ctx, async (tx) => {
      // 2 — permission. In the use case, because MCP, background jobs and
      //     future offline writes never pass through an HTTP guard (R-D2).
      await this.accessControl.require(tx, ctx, Permission.NOTE_CREATE);

      // 3 — idempotency. Fast path first, then the permanent guarantee: the
      //     unique index on (tenant_id, operation_id), which still catches a
      //     replay after the 30-day prune (R-C10).
      const replayed = await this.idempotency.find(tx, ctx, command.operationId);
      if (replayed !== null) {
        if (replayed.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used with a different payload',
          );
        }
        return replayed.response as NoteResponse;
      }

      const existing = await this.notes.findByOperationId(tx, ctx, command.operationId);
      if (existing !== null) return toResponse(existing);

      // 4 — period guard, on the business date, before anything is written.
      await this.periodGuard.assertOpen(tx, ctx, command.businessDate);

      // 5 — load aggregates. A note has no prior state; a real use case loads
      //     the product, party, lots or session it is about.

      // 6 — domain invariants. Money is validated and carried as an integer
      //     minor unit; the entry mode is derived from the business date.
      const amount = Money(command.amountMinor);
      const today = this.clock.businessDate(ctx.timezone);
      if (command.businessDate > today) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'business_date cannot be in the future');
      }
      const entryMode = entryModeFor(command.businessDate, today);

      // 7 — persist. The id is a ULID generated here, never by the database.
      const year = Number(command.businessDate.slice(0, 4));
      const note: Note = {
        id: Ulid.generate(this.clock),
        noteNumber: await this.numbering.allocate(tx, ctx, DOC_TYPE, year),
        title: command.title,
        amountMinor: amount.minor,
        businessDate: command.businessDate,
        entryMode,
        status: 'POSTED',
        operationId: command.operationId,
      };
      await this.notes.insert(tx, ctx, note);

      // 8 — journal + stock movements. A note moves no money and no stock, so
      //     it posts neither. A real document ALWAYS posts here: a balanced
      //     journal entry (INV-01) and its stock movements (INV-02), in this
      //     same transaction, never in a job afterwards.

      // 9 — audit and outbox, same transaction. `before` is null on a create;
      //     money fields appear on both sides as stored integers (R-D4).
      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: note.id,
        action: 'CREATE',
        before: null,
        after: { noteNumber: note.noteNumber, title: note.title, amountMinor: note.amountMinor },
        source: command.source,
      });

      // The outbox write is required from Phase 0 and read from Phase 12 (D7).
      // DO NOT REMOVE IT AS DEAD CODE.
      await this.outbox.append(tx, ctx, {
        eventType: 'note.created',
        aggregateType: ENTITY_TYPE,
        aggregateId: note.id,
        payload: { noteNumber: note.noteNumber, amountMinor: note.amountMinor },
      });

      const response = toResponse(note);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });

      return response;
    });
  }
}

/**
 * entry_mode is computed at write time from business_date versus the tenant-local
 * today (SRS 3.4, binding). CORRECTED is set by the use case that writes a new
 * version of an existing document, and wins over the others.
 */
export function entryModeFor(businessDate: string, today: string): EntryMode {
  if (businessDate === today) return 'ON_TIME';
  return businessDate.slice(0, 7) === today.slice(0, 7) ? 'LATE_ENTRY' : 'BACKDATED';
}

/** Canonical JSON of the payload — key order fixed, so a retry compares equal. */
function fingerprintOf(command: CreateNoteCommand): string {
  return JSON.stringify([command.title, command.amountMinor, command.businessDate]);
}

function toResponse(note: Note): NoteResponse {
  return {
    id: note.id,
    noteNumber: note.noteNumber,
    title: note.title,
    amountMinor: note.amountMinor,
    businessDate: note.businessDate,
    entryMode: note.entryMode,
    status: note.status,
  };
}
