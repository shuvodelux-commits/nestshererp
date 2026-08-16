// Use cases and ports (repository interfaces). No Drizzle, no pg, no @nestjs/*,
// no Node built-ins — enforced by `pnpm test:boundaries`.
export type { TenantContext } from './ports/tenant-context';
export type { Tx, UnitOfWork } from './ports/unit-of-work';
export type { AccessControl } from './ports/access-control';
export type { PeriodGuard } from './ports/period-guard';
export type { AuditEvent, AuditValues, AuditWriter } from './ports/audit-writer';
export type { IdempotencyRecord, IdempotencyStore } from './ports/idempotency-store';
export type { Outbox, OutboxRecord } from './ports/outbox';
export type { NumberingService } from './ports/numbering-service';
export type { EntryMode, Note, NoteRepository } from './notes/note-repository';
export { CreateNoteService, entryModeFor } from './notes/create-note-service';
export type { CreateNoteCommand } from './notes/create-note-service';
export { GetNoteService } from './notes/get-note-service';
