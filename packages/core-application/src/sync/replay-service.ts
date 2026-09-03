import {
  AppError,
  ErrorCode,
  resolutionsFor,
  SYNC_WIRE_VERSION,
} from '@sher/core-contracts';
import type {
  SyncOperation,
  SyncOperationResult,
  SyncOpType,
  SyncPushRequest,
  SyncPushResponse,
  SyncReasonCode,
} from '@sher/core-contracts';
import { occupiesWriterSlot, saleTotals } from '@sher/core-domain';
import { parseInstant, Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { DeviceRepository, DeviceRow } from '../devices/device-repository';
import type { AuditWriter } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import { label, replayOperation } from './operation-registry';
import type { SyncServices } from './operation-registry';
import { OP_DOCUMENT_TABLE } from './sync-repository';
import type { SyncOperationRow, SyncRepository } from './sync-repository';

/**
 * Taking in what the shop did while it could not reach its own books
 * (§5.23, Phase 12.4, owner decisions 2026-09-02).
 *
 * **Nothing in this file posts anything.** It decides what may be tried, in
 * what order, and what to do with the answer; the posting is done by the very
 * services the online API calls, through `operation-registry`. That separation
 * is the module's one architectural rule, and every property the shop needs
 * falls out of keeping it:
 *
 * - a replayed sale obeys the rules a counter sale obeys, because it *is* a
 *   counter sale arriving late;
 * - a refusal is a refusal, not a forced posting — a closed month, a revoked
 *   permission or a deleted product stops the operation and puts it in front of
 *   a person (SY-05, SY-06, SY-07);
 * - repeating a batch costs nothing, because the services already look up the
 *   operation id before doing anything (R-C10).
 *
 * **Why replay does not open its own transaction.** Each service opens exactly
 * one and does its whole document inside it. Wrapping that in an outer
 * transaction would take a second connection from the pool and deadlock against
 * the first. So the order here is: record the attempt, run the service, record
 * what happened — three short transactions around one real one. The bookkeeping
 * rows hold no business figure, so the only thing a crash between them can cost
 * is a row that says "in flight", and the next push resolves that from the
 * document's own permanent operation id.
 */
export class ReplayService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly sync: SyncRepository,
    private readonly devices: DeviceRepository,
    private readonly services: SyncServices,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async push(ctx: TenantContext, request: SyncPushRequest): Promise<SyncPushResponse> {
    const now = this.clock.now();

    /*
     * The wire version is checked before a single operation is looked at, and a
     * mismatch refuses the whole batch with nothing written (SY-10). A batch
     * half-understood is how a shop ends up with a day partly posted and no way
     * to tell which half.
     */
    if (request.wireVersion !== SYNC_WIRE_VERSION) {
      return {
        wireVersion: SYNC_WIRE_VERSION,
        serverTime: now.toISOString(),
        results: request.operations.map((op) => ({
          operationId: op.operationId,
          localSeq: op.localSeq,
          outcome: 'SCHEMA_INCOMPATIBLE' as const,
          serverSeq: null,
          documentId: null,
          documentNumber: null,
          reasonCode: null,
          message:
            'This computer is running an older version of the app than the shop’s books. Update it, then send again.',
          conflictId: null,
          divergence: null,
        })),
        openConflicts: await this.openConflictCount(ctx),
      };
    }

    const device = await this.uow.run(ctx, async (tx) =>
      this.devices.findByPublicKey(tx, ctx, request.deviceKey),
    );
    if (device === null) {
      throw new AppError(
        ErrorCode.PERMISSION_DENIED,
        'This computer is not registered with the shop, so nothing it holds can be accepted',
      );
    }

    /*
     * A device whose authority has gone still gets to speak — and everything it
     * says is quarantined rather than posted (§5.23: a revoked device that
     * reconnects has its outbox imported into quarantine, never applied
     * blindly). Refusing the connection outright would leave a stolen laptop's
     * day unreadable, and a shop that cannot read it cannot decide about it.
     */
    const authorityGone = !occupiesWriterSlot(device.status);

    /*
     * Who this machine was allowed to be.
     *
     * Every operation names the person who did the work, and the books take
     * that name as the actor — it is the whole point of replaying under the
     * cashier rather than under whoever was signed in when the line came back
     * (§5.22, §5.23). But the name arrives from a machine that has been sitting
     * unattended in a shop, and offline sign-in leaves the session on that
     * machine's own disk. So the name is a claim, and a claim is checked.
     *
     * The set it is checked against is the same one the snapshot went down
     * with: the people the owner ticked for this device. An operation naming
     * anybody else is quarantined rather than posted, because the alternative
     * is a day's takings filed under a colleague who never touched the till —
     * and, since permissions are resolved from the named user's role, work
     * posted with authority its author never had.
     *
     * **An empty list checks nothing**, deliberately. Ticking people is a
     * separate decision from approving the machine, and a shop that approved a
     * counter PC without making it has said nothing about who may work on it.
     * Quarantining a whole day's takings on the strength of a decision the
     * owner was never asked to make would cost far more than it protects, so
     * the old behaviour stands until the list exists. Ticking even one person
     * turns the check on.
     */
    const permittedUserIds = new Set(
      (await this.uow.run(ctx, async (tx) => this.devices.listDeviceUsers(tx, ctx, device.id))).map(
        (user) => user.userId,
      ),
    );

    const results: SyncOperationResult[] = [];
    const outcomeBySeq = new Map<number, SyncOperationResult>();

    for (const op of order(request.operations)) {
      const result = await this.one(ctx, device, op, outcomeBySeq, authorityGone, permittedUserIds);
      outcomeBySeq.set(op.localSeq, result);
      results.push(result);
    }

    await this.uow.run(ctx, async (tx) => {
      await this.devices.recordSeen(tx, ctx, device.id, now);
      await this.sync.recordPush(tx, ctx, device.id, now);

      /*
       * A machine being handed over has now finished speaking.
       *
       * `DRAINING` occupies the shop's single writer slot on purpose (D-01):
       * a machine on its way out has not finished sending up what it holds, and
       * a second writer alongside it is the one thing that rule exists to
       * prevent. But something has to end it, or a revoked counter PC keeps the
       * slot forever and the shop can never approve its replacement without the
       * owner re-entering their password to force the old one off.
       *
       * The device's own word is the only honest signal — the server sees what
       * has arrived, never what has not — and it is safe to trust: a machine
       * that says this too early ends its own authority, and anything it had
       * not sent is refused afterwards rather than posted.
       */
      if (device.status === 'DRAINING' && request.queueEmpty && !anythingRefused(results)) {
        await this.devices.changeStatus(tx, ctx, device.id, {
          status: 'REVOKED',
          at: now,
          revoked: true,
          reason: 'Finished sending everything it was holding',
        });
        await this.audit.append(tx, ctx, {
          entityType: 'device_authorization',
          entityId: device.id,
          action: 'DRAINED',
          before: { status: 'DRAINING' },
          after: { status: 'REVOKED', operations: results.length },
          source: 'SYNC',
        });
      }
    });

    return {
      wireVersion: SYNC_WIRE_VERSION,
      serverTime: now.toISOString(),
      // In the order the device sent them, not the order they were replayed —
      // the device matches these against its own queue by operation id anyway,
      // and a reordered list reads like something went wrong.
      results: request.operations.map(
        (op) => results.find((r) => r.operationId === op.operationId) ?? missing(op),
      ),
      openConflicts: await this.openConflictCount(ctx),
    };
  }

  /** One operation, from what is already known about it to what became of it. */
  private async one(
    ctx: TenantContext,
    device: DeviceRow,
    op: SyncOperation,
    earlier: ReadonlyMap<number, SyncOperationResult>,
    authorityGone: boolean,
    permittedUserIds: ReadonlySet<string>,
  ): Promise<SyncOperationResult> {
    const now = this.clock.now();

    // Already known? Then this is a resumed or repeated push, and the answer is
    // whatever it was the first time (SY-02, SY-03).
    const seen = await this.uow.run(ctx, async (tx) =>
      this.sync.findOperationByOperationId(tx, ctx, op.operationId),
    );
    if (seen !== null) {
      const settled = this.settled(seen, op);
      if (settled !== null) return settled;
    }

    if (authorityGone) {
      return this.quarantine(ctx, device, op, seen, {
        reason: 'AUTHORITY_REVOKED',
        message:
          'This computer’s permission to work offline was taken away before it sent this up. Nothing it holds goes into the books until somebody decides about it.',
        outcome: 'AUTHORITY_REVOKED',
      });
    }

    /*
     * A name this machine was never allowed to work under.
     *
     * Checked before anything is looked up or posted, and quarantined rather
     * than refused outright: the work itself may be perfectly good — a real
     * sale, a real customer, real money in the drawer — and throwing it away
     * because the name on it is wrong would cost the shop the day. A person
     * decides, with the operation in front of them.
     */
    if (permittedUserIds.size > 0 && !permittedUserIds.has(op.context.userId)) {
      return this.quarantine(ctx, device, op, seen, {
        reason: 'PERMISSION_REVOKED',
        message:
          'This computer sent up work under somebody who is not on its list of people. Nothing goes into the books until somebody says who actually did it.',
      });
    }

    /*
     * Dependency order is not an optimisation — a sale naming a product created
     * during the same outage cannot be posted before that product exists (§3).
     * If what it waits on did not get in, neither does it, and the message says
     * which one to fix.
     */
    const blocked = op.dependsOn
      .map((seq) => earlier.get(seq))
      .find((r) => r !== undefined && r.outcome !== 'APPLIED' && r.outcome !== 'DUPLICATE');
    if (blocked !== undefined) {
      return this.quarantine(ctx, device, op, seen, {
        reason: 'DEPENDENCY_FAILED',
        message: `This ${label(op.type)} needs something earlier in the queue that the books would not accept. Sort that one out first and this goes in by itself.`,
      });
    }

    /*
     * A sequence number this machine has already used, for a different
     * operation. The counter went backwards — a backup restored over a queue
     * that had moved on, or two profiles sharing copied storage — and the one
     * thing that must not happen is the second operation quietly taking the
     * first one's place. It is refused with the number named, and the machine's
     * queue is a matter for a person (§21, §22).
     */
    const reused = await this.uow.run(ctx, async (tx) =>
      this.sync.findOperationByDeviceSeq(tx, ctx, device.id, op.localSeq),
    );
    if (reused !== null && reused.operationId !== op.operationId) {
      return {
        operationId: op.operationId,
        localSeq: op.localSeq,
        outcome: 'BLOCKED',
        serverSeq: null,
        documentId: null,
        documentNumber: null,
        reasonCode: 'UNKNOWN',
        message: `This computer has already sent something under number ${String(op.localSeq)}. Its queue has to be looked at before this can go in.`,
        conflictId: null,
        divergence: null,
      };
    }

    const record = seen ?? (await this.record(ctx, device, op, now));

    /*
     * An operation found already in flight was interrupted between its posting
     * and the row that says so. Ten of the thirteen types carry their operation
     * id into their own table's unique index, so running them again is provably
     * free. The three that do not are put in front of a person instead, because
     * running one of those twice would open a second day or move the money
     * again and nothing in the schema would catch it.
     */
    if (seen !== null && seen.status === 'IN_FLIGHT' && !REPLAY_IS_FREE.has(op.type)) {
      return this.quarantine(ctx, device, op, seen, {
        reason: 'UNKNOWN',
        message: `This ${label(op.type)} was interrupted while it was going into the books. Check whether it is already there before sending it again.`,
      });
    }

    const money = this.moneyRefusal(op);
    if (money !== null) {
      /*
       * §5: what the customer was charged is on paper in their hand. A payload
       * whose own figures do not add up is refused **before** anything posts,
       * so the books never quietly hold a different total from the slip.
       */
      return this.quarantine(ctx, device, op, record, {
        reason: 'AMOUNT_DIVERGENCE',
        message: money.message,
        divergence: money.divergence,
      });
    }

    try {
      const payload = await this.remap(ctx, op.payload);
      const replayCtx: TenantContext = {
        tenantId: ctx.tenantId,
        // The actor is who did the work, not who was signed in when the line
        // came back (§5.23's replay rules, and §5.22's audit trail).
        userId: op.context.userId,
        timezone: ctx.timezone,
        deviceCode: device.deviceCode,
      };

      const replayed = await replayOperation(
        this.services,
        replayCtx,
        op.type,
        op.operationId,
        payload,
        { documentNumber: op.documentNumber ?? null },
      );

      const at = this.clock.now();
      const serverSeq = await this.uow.run(ctx, async (tx) => {
        const seq = await this.sync.recordOutcome(tx, ctx, record.id, {
          status: 'APPLIED',
          resultDocumentId: replayed.documentId,
          resultDocumentNumber: replayed.documentNumber,
          serverResultDigest: replayed.digest,
          assignServerSeq: true,
          at,
        });

        /*
         * The origin trail (§18). Permanent, informational, and never anything
         * else: it says which machine typed the document and when, so a "Made
         * offline" tag and a list filter have a fact to stand on. It changes no
         * figure and no status — a synced offline document is an ordinary
         * posted document in every other respect.
         */
        await this.sync.markOffline(tx, ctx, {
          table: OP_DOCUMENT_TABLE[op.type],
          documentId: replayed.documentId,
          deviceId: device.id,
          deviceCreatedAt: instantOf(op.context.deviceCreatedAt, this.clock),
          deviceSeq: op.localSeq,
          syncedAt: at,
        });

        await this.audit.append(tx, ctx, {
          entityType: OP_DOCUMENT_TABLE[op.type],
          entityId: replayed.documentId,
          action: 'SYNC_APPLY',
          before: null,
          after: {
            operationId: op.operationId,
            deviceCode: device.deviceCode,
            localSeq: op.localSeq,
            deviceCreatedAt: op.context.deviceCreatedAt,
          },
          source: 'SYNC',
        });
        return seq;
      });

      return {
        operationId: op.operationId,
        localSeq: op.localSeq,
        outcome: 'APPLIED',
        serverSeq,
        documentId: replayed.documentId,
        documentNumber: replayed.documentNumber,
        reasonCode: null,
        message: null,
        conflictId: null,
        divergence: null,
      };
    } catch (cause) {
      const { reason, message } = classify(cause, op.type);

      /*
       * The document's own `(tenant_id, operation_id)` unique index refused the
       * insert. That is not a failure — it is R-C10's permanent guarantee doing
       * exactly its job: the document is already in the books under this
       * operation id, written by an earlier attempt whose answer never reached
       * the device, or by a concurrent push of the same batch.
       *
       * Found by SY-03: a push killed mid-batch leaves the server still working
       * through it, and the device's resume arrives while the first copy is
       * still being posted. Both replays check "not posted yet", both insert,
       * and one of them meets the index. Quarantining that would put a sale in
       * front of a manager to decide about when it is already sold.
       */
      if (reason === 'ALREADY_POSTED') {
        const posted = await this.uow.run(ctx, async (tx) => {
          await this.sync.recordOutcome(tx, ctx, record.id, {
            status: 'DUPLICATE',
            at: this.clock.now(),
          });
          return this.sync.findOperationByOperationId(tx, ctx, op.operationId);
        });
        return {
          operationId: op.operationId,
          localSeq: op.localSeq,
          outcome: 'DUPLICATE',
          serverSeq: posted?.serverSeq ?? null,
          documentId: posted?.resultDocumentId ?? null,
          documentNumber: posted?.resultDocumentNumber ?? op.documentNumber ?? null,
          reasonCode: null,
          message: null,
          conflictId: null,
          divergence: null,
        };
      }

      if (reason === 'IDEMPOTENCY') {
        return {
          operationId: op.operationId,
          localSeq: op.localSeq,
          outcome: 'IDEMPOTENCY_MISMATCH',
          serverSeq: null,
          documentId: null,
          documentNumber: null,
          reasonCode: null,
          message,
          conflictId: null,
          divergence: null,
        };
      }
      return this.quarantine(ctx, device, op, record, { reason, message });
    }
  }

  /**
   * What a device is told about an operation the shop has already settled.
   *
   * `APPLIED` and `DUPLICATE` both come back as `DUPLICATE`, and the device
   * clears them from its queue exactly as it clears a fresh acceptance — that
   * is what makes a resumed push produce no duplicates and no gaps (SY-03).
   */
  private settled(seen: SyncOperationRow, op: SyncOperation): SyncOperationResult | null {
    const base = {
      operationId: op.operationId,
      localSeq: op.localSeq,
      serverSeq: seen.serverSeq,
      documentId: seen.resultDocumentId,
      documentNumber: seen.resultDocumentNumber,
      divergence: seen.divergence,
    };

    switch (seen.status) {
      case 'APPLIED':
      case 'DUPLICATE':
        return { ...base, outcome: 'DUPLICATE', reasonCode: null, message: null, conflictId: null };
      case 'DISCARDED':
        return {
          ...base,
          outcome: 'BLOCKED',
          reasonCode: null,
          message:
            'The shop decided this one will never be posted. It stays readable, and it will not be tried again.',
          conflictId: null,
        };
      case 'QUARANTINED':
      case 'IN_FLIGHT':
      case 'BLOCKED':
        // Not settled: a quarantined operation may be retried, and one left in
        // flight is decided further down.
        return null;
    }
  }

  private async record(
    ctx: TenantContext,
    device: DeviceRow,
    op: SyncOperation,
    now: Date,
  ): Promise<SyncOperationRow> {
    const id = Ulid.generate(this.clock);
    return this.uow.run(ctx, async (tx) => {
      await this.sync.insertOperation(tx, ctx, {
        id,
        deviceId: device.id,
        operationId: op.operationId,
        localSeq: op.localSeq,
        opType: op.type,
        payload: op.payload,
        context: op.context,
        dependsOn: op.dependsOn,
        clientResultDigest: op.clientResultDigest ?? null,
        deviceCreatedAt: instantOf(op.context.deviceCreatedAt, this.clock),
        businessDate: op.context.businessDate,
        receivedAt: now,
      });
      const row = await this.sync.findOperationByOperationId(tx, ctx, op.operationId);
      if (row === null) throw new Error('sync operation vanished immediately after insert');
      return row;
    });
  }

  private async quarantine(
    ctx: TenantContext,
    device: DeviceRow,
    op: SyncOperation,
    existing: SyncOperationRow | null,
    refusal: {
      readonly reason: SyncReasonCode;
      readonly message: string;
      readonly outcome?: 'QUARANTINED' | 'AUTHORITY_REVOKED';
      readonly divergence?: Record<string, number> | null;
    },
  ): Promise<SyncOperationResult> {
    const now = this.clock.now();
    const record = existing ?? (await this.record(ctx, device, op, now));

    const conflictId = await this.uow.run(ctx, async (tx) => {
      await this.sync.recordOutcome(tx, ctx, record.id, {
        status: 'QUARANTINED',
        errorCode: refusal.reason,
        errorMessage: refusal.message,
        divergence: refusal.divergence ?? null,
        at: now,
      });
      await this.sync.countAttempt(tx, ctx, record.id, now);

      const id = Ulid.generate(this.clock);
      return this.sync.upsertConflict(tx, ctx, {
        id,
        syncOperationId: record.id,
        reasonCode: refusal.reason,
        reasonMessage: refusal.message,
        // Both sides in one row, because the manager resolving this is standing
        // at a counter and cannot open the document that does not exist yet.
        localState: op.clientResultDigest ?? null,
        serverState: refusal.divergence ?? null,
        suggestedActions: resolutionsFor(refusal.reason),
        at: now,
      });
    });

    return {
      operationId: op.operationId,
      localSeq: op.localSeq,
      outcome: refusal.outcome ?? 'QUARANTINED',
      serverSeq: null,
      documentId: null,
      documentNumber: null,
      reasonCode: refusal.reason,
      message: refusal.message,
      conflictId,
      divergence: refusal.divergence ?? null,
    };
  }

  /**
   * Whether the money the machine printed and the money its own payload implies
   * are the same figure.
   *
   * Checked **before** anything posts, and computed with the very domain
   * function the posting service uses, so this can only disagree when a payload
   * has been damaged or tampered with between the counter and here. Which is
   * exactly when a person should look at it rather than a total being quietly
   * replaced (§5).
   */
  private moneyRefusal(
    op: SyncOperation,
  ): { readonly message: string; readonly divergence: Record<string, number> } | null {
    if (op.type !== 'SALE_CREATE') return null;
    const claimed = op.clientResultDigest;
    if (claimed === undefined) return null;

    const computed = saleMoneyOf(op.payload);
    if (computed === null) return null;

    const divergence: Record<string, number> = {};
    for (const [key, value] of Object.entries(claimed)) {
      const ours = computed[key as keyof typeof computed];
      if (ours !== undefined && value !== undefined && ours !== value) {
        divergence[`printed_${key}`] = value;
        divergence[`books_${key}`] = ours;
      }
    }
    if (Object.keys(divergence).length === 0) return null;

    return {
      message:
        'The amounts on the printed slip do not match what this sale adds up to. The customer’s copy is not changed — somebody has to look at this one.',
      divergence,
    };
  }

  /**
   * Rewrites references to things created during the same outage.
   *
   * A product created offline has no server id until it posts, so the machine
   * refers to it by the operation id it created it under, and this swaps in the
   * real id once that operation has landed. Only ids this shop has actually
   * accepted are ever substituted — anything else is left exactly as it came,
   * so a payload can never be edited into meaning something the counter did not
   * type.
   */
  private async remap(ctx: TenantContext, payload: unknown): Promise<unknown> {
    const ids = new Set<string>();
    walkIds(payload, (id) => ids.add(id));
    if (ids.size === 0) return payload;

    const mapping = await this.uow.run(ctx, async (tx) =>
      this.sync.resolveLocalIds(tx, ctx, [...ids]),
    );
    if (mapping.size === 0) return payload;

    return rewriteIds(payload, mapping);
  }

  private async openConflictCount(ctx: TenantContext): Promise<number> {
    return this.uow.run(ctx, async (tx) => (await this.sync.counts(tx, ctx)).openConflicts);
  }
}

/**
 * An ISO instant a device sent, as a `Date`.
 *
 * Through `parseInstant` rather than `new Date(...)`: time comes from one
 * place in this codebase (the Clock port and its helpers), and a device's
 * timestamp is exactly the sort of value that should be parsed by the same
 * code everything else is. A string that will not parse falls back to now,
 * which is the only honest answer when the machine's clock lied.
 */
function instantOf(iso: string, clock: Clock): Date {
  return parseInstant(iso) ?? clock.now();
}

/**
 * What a sale's own payload adds up to, by the same arithmetic the posting
 * service uses (`saleTotals`, §3.3's largest-remainder discount spread).
 *
 * The device runs this same function before it prints, which is why the two
 * figures normally agree to the poisha — `core-domain` is browser-safe by
 * design, exactly so the counter and the books can share their arithmetic
 * instead of having one each.
 *
 * Null when the payload is not shaped like a sale at all; the schema will
 * refuse it a moment later with a better sentence than this could give.
 */
function saleMoneyOf(payload: unknown): Record<string, number> | null {
  if (payload === null || typeof payload !== 'object') return null;
  const body = payload as {
    lines?: readonly { qty?: unknown; unitPriceMinor?: unknown; lineDiscountMinor?: unknown; productId?: unknown }[];
    discountMinor?: unknown;
    payments?: readonly { amountMinor?: unknown }[];
  };
  if (!Array.isArray(body.lines) || typeof body.discountMinor !== 'number') return null;

  try {
    const totals = saleTotals({
      lines: body.lines.map((line) => ({
        productId: String(line.productId ?? ''),
        qty: Number(line.qty),
        unitPriceMinor: Number(line.unitPriceMinor),
        lineDiscountMinor: Number(line.lineDiscountMinor ?? 0),
      })),
      discountMinor: body.discountMinor,
      paidMinor: (body.payments ?? []).reduce((sum, p) => sum + Number(p.amountMinor ?? 0), 0),
    });
    return {
      itemsTotalMinor: totals.itemsTotalMinor,
      discountMinor: totals.discountMinor,
      grandTotalMinor: totals.grandTotalMinor,
      paidMinor: totals.paidMinor,
      dueMinor: totals.dueMinor,
    };
  } catch {
    // `saleTotals` throws on a draft the domain would refuse outright. That is
    // not a money disagreement; it is an invalid sale, and the service says so.
    return null;
  }
}

/**
 * The types whose services carry the operation id into their own table's unique
 * index, and can therefore be run again after an interruption for free.
 *
 * Opening a day, closing a day and moving money do not, so they are decided by
 * a person instead (see migration 0049).
 */
const REPLAY_IS_FREE: ReadonlySet<SyncOpType> = new Set([
  'SALE_CREATE',
  'PURCHASE_CREATE',
  'SALES_RETURN_CREATE',
  'PURCHASE_RETURN_CREATE',
  'CUSTOMER_RECEIPT_RECORD',
  'SUPPLIER_PAYMENT_RECORD',
  'EXPENSE_RECORD',
  'STOCK_ADJUST',
  'PARTY_CREATE',
  'PRODUCT_CREATE',
]);

/**
 * Dependency first, then the order the shop typed them (§3).
 *
 * A stable topological sort over `dependsOn`, falling back to `localSeq`, which
 * is the machine's own strictly increasing counter. Timestamps are deliberately
 * not used to order anything: two operations can share a millisecond, and a
 * clock that drifts would reorder a day.
 *
 * A cycle — which a correct device cannot produce — is not an error worth
 * refusing a day's takings over: the remaining operations fall back to
 * `localSeq` order, and anything genuinely out of order is refused by the
 * service that receives it.
 */
function order(ops: readonly SyncOperation[]): readonly SyncOperation[] {
  const bySeq = new Map(ops.map((op) => [op.localSeq, op]));
  const done = new Set<number>();
  const out: SyncOperation[] = [];

  const visit = (op: SyncOperation, seen: ReadonlySet<number>): void => {
    if (done.has(op.localSeq) || seen.has(op.localSeq)) return;
    const deeper = new Set(seen).add(op.localSeq);
    for (const seq of [...op.dependsOn].sort((a, b) => a - b)) {
      const parent = bySeq.get(seq);
      if (parent !== undefined) visit(parent, deeper);
    }
    if (done.has(op.localSeq)) return;
    done.add(op.localSeq);
    out.push(op);
  };

  for (const op of [...ops].sort((a, b) => a.localSeq - b.localSeq)) visit(op, new Set());
  return out;
}

/** A ULID is 26 characters of Crockford base32; nothing else is remapped. */
const ULID_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function walkIds(value: unknown, found: (id: string) => void): void {
  if (typeof value === 'string') {
    if (ULID_SHAPE.test(value)) found(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkIds(item, found);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) walkIds(item, found);
  }
}

function rewriteIds(value: unknown, mapping: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return mapping.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => rewriteIds(item, mapping));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteIds(item, mapping)]),
    );
  }
  return value;
}

/**
 * A refusal from the application layer, turned into the reason a shopkeeper
 * reads and the set of things they may do about it.
 *
 * The service's own sentence is kept: it was written for the person who caused
 * the refusal, and rewriting it here would put a second, vaguer explanation in
 * front of the one that is actually true.
 */
function classify(
  cause: unknown,
  type: SyncOpType,
): { readonly reason: SyncReasonCode | 'IDEMPOTENCY' | 'ALREADY_POSTED'; readonly message: string } {
  /*
   * The document table's own operation-id index, met head on. Recognised by the
   * constraint name because that is the only thing the driver gives us, and
   * every document table names its index the same way (`..._operation_unique`).
   */
  if (cause instanceof Error && /_operation_unique/.test(cause.message)) {
    return { reason: 'ALREADY_POSTED', message: 'Already in the books under this operation id' };
  }

  if (cause instanceof AppError) {
    switch (cause.code) {
      case ErrorCode.PERIOD_LOCKED:
        return { reason: 'PERIOD_CLOSED', message: cause.message };
      case ErrorCode.PERMISSION_DENIED:
        return { reason: 'PERMISSION_REVOKED', message: cause.message };
      case ErrorCode.NOT_FOUND:
        return { reason: 'ENTITY_MISSING', message: cause.message };
      case ErrorCode.CONFLICT_STALE_VERSION:
        return { reason: 'UNIQUE_COLLISION', message: cause.message };
      case ErrorCode.IDEMPOTENCY_KEY_REUSED:
        return {
          reason: 'IDEMPOTENCY',
          message:
            'This computer sent two different documents under the same operation id. Neither is posted; the queue needs looking at.',
        };
      case ErrorCode.VALIDATION_FAILED:
        /*
         * The application layer refuses a great many different things with
         * VALIDATION_FAILED, and they are not the same kind of problem to a
         * manager clearing a queue. Where the refusal carried a machine-
         * readable reason (§5.26's envelope), it decides which Sync Issue this
         * is — and therefore which actions the screen offers.
         */
        switch (cause.details?.['reason']) {
          case 'DUPLICATE_CUSTOMER_PHONE':
            return { reason: 'UNIQUE_COLLISION', message: cause.message };
          case 'PRODUCT_INACTIVE':
            return { reason: 'ENTITY_INACTIVE', message: cause.message };
          default:
            return { reason: 'VALIDATION_FAILED', message: cause.message };
        }
      default:
        return { reason: 'BUSINESS_RULE', message: cause.message };
    }
  }
  /*
   * Not a refusal the application layer produced — a bug, a driver error, a
   * constraint nobody expected. The shopkeeper's sentence stays plain, and the
   * technical detail is carried with it rather than thrown away: a Sync Issue
   * saying only "it did not say why" is the one kind nobody can ever clear.
   */
  const detail = cause instanceof Error ? cause.message : String(cause);
  return {
    reason: 'UNKNOWN',
    message: `The shop’s books could not take this ${label(type)}. Show this to support: ${detail}`,
  };
}

/** Whether this batch left anything a person still has to decide about. */
function anythingRefused(results: readonly SyncOperationResult[]): boolean {
  return results.some((r) => r.outcome !== 'APPLIED' && r.outcome !== 'DUPLICATE');
}

function missing(op: SyncOperation): SyncOperationResult {
  return {
    operationId: op.operationId,
    localSeq: op.localSeq,
    outcome: 'BLOCKED',
    serverSeq: null,
    documentId: null,
    documentNumber: null,
    reasonCode: 'UNKNOWN',
    message: 'This one was not reached in this batch. Send again.',
    conflictId: null,
    divergence: null,
  };
}
