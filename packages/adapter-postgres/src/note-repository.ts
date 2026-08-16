import type { EntryMode, Note, NoteRepository, TenantContext, Tx } from '@sher/core-application';
import type { Clock } from '@sher/shared-utils';
import { and, eq, isNull } from 'drizzle-orm';

import { notes } from './schema';
import { txOf } from './unit-of-work';

interface NoteRow {
  id: string;
  noteNumber: string;
  title: string;
  amountMinor: number;
  businessDate: string;
  entryMode: string;
  status: string;
  operationId: string;
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id.trim(),
    noteNumber: row.noteNumber,
    title: row.title,
    amountMinor: row.amountMinor,
    businessDate: row.businessDate,
    entryMode: row.entryMode as EntryMode,
    status: row.status as Note['status'],
    operationId: row.operationId.trim(),
  };
}

/**
 * Every query is tenant-scoped from TenantContext (R-C4). A note belonging to
 * another tenant is simply not found — which is how the API returns 404 rather
 * than confirming its existence with a 403.
 *
 * No business calculation happens here (R-B6): the repository reads and writes,
 * nothing more.
 */
export class PostgresNoteRepository implements NoteRepository {
  constructor(private readonly clock: Clock) {}

  async insert(tx: Tx, ctx: TenantContext, note: Note): Promise<void> {
    const now = this.clock.now();
    await txOf(tx)
      .insert(notes)
      .values({
        id: note.id,
        tenantId: ctx.tenantId,
        noteNumber: note.noteNumber,
        title: note.title,
        amountMinor: note.amountMinor,
        businessDate: note.businessDate,
        entryMode: note.entryMode,
        status: note.status,
        operationId: note.operationId,
        createdAt: now,
        updatedAt: now,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
        version: 1,
      });
  }

  async findById(tx: Tx, ctx: TenantContext, id: string): Promise<Note | null> {
    const rows = await txOf(tx)
      .select(SELECTED)
      .from(notes)
      .where(and(eq(notes.tenantId, ctx.tenantId), eq(notes.id, id), isNull(notes.deletedAt)))
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : toNote(row);
  }

  async findByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<Note | null> {
    const rows = await txOf(tx)
      .select(SELECTED)
      .from(notes)
      .where(
        and(
          eq(notes.tenantId, ctx.tenantId),
          eq(notes.operationId, operationId),
          isNull(notes.deletedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    return row === undefined ? null : toNote(row);
  }
}

/** Explicit column list — never `SELECT *`, which breaks silently on a schema change. */
const SELECTED = {
  id: notes.id,
  noteNumber: notes.noteNumber,
  title: notes.title,
  amountMinor: notes.amountMinor,
  businessDate: notes.businessDate,
  entryMode: notes.entryMode,
  status: notes.status,
  operationId: notes.operationId,
};
