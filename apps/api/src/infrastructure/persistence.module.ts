import { Global, Module } from '@nestjs/common';
import {
  createDatabase,
  createPool,
  PostgresAccessControl,
  PostgresAuditWriter,
  PostgresIdempotencyStore,
  PostgresNoteRepository,
  PostgresNumberingService,
  PostgresOutbox,
  PostgresPeriodGuard,
  PostgresUnitOfWork,
} from '@sher/adapter-postgres';
import type { Clock } from '@sher/shared-utils';
import { SystemClock } from '@sher/shared-utils';
import type pg from 'pg';

import { loadConfig } from '../config';
import type { ApiConfig } from '../config';
import {
  ACCESS_CONTROL,
  API_CONFIG,
  AUDIT_WRITER,
  CLOCK,
  DATABASE_POOL,
  IDEMPOTENCY_STORE,
  NOTE_REPOSITORY,
  NUMBERING_SERVICE,
  OUTBOX,
  PERIOD_GUARD,
  UNIT_OF_WORK,
} from './tokens';

/**
 * The single wiring point between the application layer and PostgreSQL.
 *
 * Use cases depend on interfaces only; this module decides which implementation
 * satisfies them. Swapping in the SQLite WASM adapter in Phase 12 is a change
 * here and nowhere else (D-14).
 */
@Global()
@Module({
  providers: [
    { provide: API_CONFIG, useFactory: loadConfig },
    { provide: CLOCK, useFactory: (): Clock => new SystemClock() },
    {
      provide: DATABASE_POOL,
      useFactory: (config: ApiConfig): pg.Pool => createPool(config.databaseUrl),
      inject: [API_CONFIG],
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (pool: pg.Pool): PostgresUnitOfWork =>
        new PostgresUnitOfWork(createDatabase(pool)),
      inject: [DATABASE_POOL],
    },
    { provide: ACCESS_CONTROL, useFactory: (): PostgresAccessControl => new PostgresAccessControl() },
    { provide: PERIOD_GUARD, useFactory: (): PostgresPeriodGuard => new PostgresPeriodGuard() },
    {
      provide: AUDIT_WRITER,
      useFactory: (clock: Clock): PostgresAuditWriter => new PostgresAuditWriter(clock),
      inject: [CLOCK],
    },
    {
      provide: IDEMPOTENCY_STORE,
      useFactory: (clock: Clock): PostgresIdempotencyStore => new PostgresIdempotencyStore(clock),
      inject: [CLOCK],
    },
    {
      provide: OUTBOX,
      useFactory: (clock: Clock): PostgresOutbox => new PostgresOutbox(clock),
      inject: [CLOCK],
    },
    {
      provide: NUMBERING_SERVICE,
      useFactory: (clock: Clock): PostgresNumberingService => new PostgresNumberingService(clock),
      inject: [CLOCK],
    },
    {
      provide: NOTE_REPOSITORY,
      useFactory: (clock: Clock): PostgresNoteRepository => new PostgresNoteRepository(clock),
      inject: [CLOCK],
    },
  ],
  exports: [
    API_CONFIG,
    CLOCK,
    DATABASE_POOL,
    UNIT_OF_WORK,
    ACCESS_CONTROL,
    PERIOD_GUARD,
    AUDIT_WRITER,
    IDEMPOTENCY_STORE,
    OUTBOX,
    NUMBERING_SERVICE,
    NOTE_REPOSITORY,
  ],
})
export class PersistenceModule {}
