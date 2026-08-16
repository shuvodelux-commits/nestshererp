import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/** Entry mode is computed by the use case at write time (SRS 3.4). */
export type EntryMode = 'ON_TIME' | 'LATE_ENTRY' | 'BACKDATED' | 'CORRECTED';

export interface Note {
  readonly id: string;
  readonly noteNumber: string;
  readonly title: string;
  /** Integer poisha. */
  readonly amountMinor: number;
  readonly businessDate: string;
  readonly entryMode: EntryMode;
  readonly status: 'DRAFT' | 'POSTED' | 'VOIDED';
  readonly operationId: string;
}

/**
 * Business-specific repository interface — no BaseRepository, no generic CRUD
 * (R-B7). Implementations live in adapter-postgres and never expose Drizzle
 * types, which is what keeps a SQLite WASM implementation possible (D-14).
 *
 * Every method is tenant-scoped through TenantContext; none of them accepts a
 * tenant id as a free parameter.
 */
export interface NoteRepository {
  insert(tx: Tx, ctx: TenantContext, note: Note): Promise<void>;
  /** Returns null when the note does not exist OR belongs to another tenant. */
  findById(tx: Tx, ctx: TenantContext, id: string): Promise<Note | null>;
  findByOperationId(tx: Tx, ctx: TenantContext, operationId: string): Promise<Note | null>;
}
