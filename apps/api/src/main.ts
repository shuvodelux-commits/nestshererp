import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import express from 'express';

import { AppModule } from './app.module';
import { AppErrorFilter } from './common/app-error.filter';
import { corsOptions } from './common/cors';
import { securityHeaders } from './common/security-headers';
import { loadConfig } from './config';
import { validateBootConfig } from './deployment/boot-validation';
import { assertSchemaMatchesBuild } from './deployment/schema-version-gate';
import { MIGRATIONS_DIRECTORY, newestMigration } from './infrastructure/build-info';
import { createPool } from '@sher/adapter-postgres';
import { SystemClock } from '@sher/shared-utils';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  // §4.4: boot-time validation is mandatory, and it runs **before** anything is
  // constructed. A deployment configured into one of the refused combinations
  // must never reach the point of answering a request.
  validateBootConfig(config);

  /*
   * Phase 10: the schema gate, before the application is built.
   *
   * On its own pool, closed immediately. Reaching for the injected one would
   * mean constructing the whole module graph first — and the whole point is
   * that a mismatched installation never gets that far.
   */
  const gatePool = createPool(config.databaseUrl);
  try {
    await assertSchemaMatchesBuild(gatePool, newestMigration(MIGRATIONS_DIRECTORY));
  } finally {
    await gatePool.end();
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  /*
   * A `.sherdb` restore arrives base64 in the body like every other upload, and
   * it is the whole business — orders of magnitude past the 12 MB a statement
   * PDF needs. Mounted first and only on this path, so raising the ceiling for
   * a recovery does not raise it for every endpoint a browser can reach.
   */
  app.use('/api/v1/backup', express.json({ limit: '1024mb' }));
  /*
   * Files travel in the JSON body on this API — the guided CSV import (§5.6)
   * and, from Phase 11, a bank statement PDF (§5.17). Express defaults to
   * 100 kB, which a statement passes in the first page, so the ceiling is
   * raised once here to match the 8 MB the upload contract allows plus its
   * base64 overhead. A limit that silently truncates an upload is worse than
   * one that refuses it loudly.
   */
  app.useBodyParser('json', { limit: '12mb' });
  // Before every route, including the ones mounted above it: a header that
  // only some responses carry is a header a reader cannot rely on.
  app.use(securityHeaders);
  // The clock is handed in: the filter records a Phase 17 diagnostic for every
  // failure, and R-C8 allows no ambient clock even in a hand-built object.
  app.useGlobalFilters(new AppErrorFilter(new SystemClock()));
  // The Vue app is served from its own origin (the Vite dev server locally,
  // nginx in §6.5), so the browser preflights every mutating call. The allowed
  // header list lives in one place — see `corsOptions`.
  app.enableCors(corsOptions(config.webOrigin));
  await app.listen(config.port);
}

void bootstrap();
