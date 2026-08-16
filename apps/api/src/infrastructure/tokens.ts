/** DI tokens for ports whose types are interfaces (interfaces have no runtime value). */
export const API_CONFIG = Symbol('ApiConfig');
export const CLOCK = Symbol('Clock');
export const DATABASE_POOL = Symbol('DatabasePool');
export const UNIT_OF_WORK = Symbol('UnitOfWork');
export const ACCESS_CONTROL = Symbol('AccessControl');
export const PERIOD_GUARD = Symbol('PeriodGuard');
export const AUDIT_WRITER = Symbol('AuditWriter');
export const IDEMPOTENCY_STORE = Symbol('IdempotencyStore');
export const OUTBOX = Symbol('Outbox');
export const NUMBERING_SERVICE = Symbol('NumberingService');
export const NOTE_REPOSITORY = Symbol('NoteRepository');
