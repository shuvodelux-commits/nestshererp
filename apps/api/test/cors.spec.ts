import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { corsOptions } from '../src/common/cors';
import { prepareTestDatabase, testPool } from './support/database';

/**
 * The browser's preflight, asserted against the **same** `corsOptions` the
 * production bootstrap applies.
 *
 * This test exists because of a defect it would have caught: `idempotency-key`
 * was missing from the allowed-header list, so every create that carries an
 * operation id — every product, every party — was blocked by the browser before
 * the request was sent. The screen showed a dead network; the server logged
 * nothing, because nothing arrived.
 *
 * Every other integration test in this suite passed throughout, because
 * supertest speaks HTTP directly and never preflights. That is the gap S2 names:
 * "a module is not complete because the backend compiles ... it is complete when
 * its whole workflow works in the UI".
 */
const WEB_ORIGIN = 'http://localhost:5173';

let app: INestApplication;
let pool: pg.Pool;

beforeAll(async () => {
  pool = testPool();
  await prepareTestDatabase();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.enableCors(corsOptions(WEB_ORIGIN));
  await app.init();
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

/** What the browser actually asks before a create is allowed to leave. */
function preflight(path: string, headers: string): request.Test {
  return request(app.getHttpServer())
    .options(path)
    .set('Origin', WEB_ORIGIN)
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', headers);
}

describe('what the browser is allowed to send', () => {
  it('allows the three headers the web client actually sets', async () => {
    // `client.ts` sets exactly these: content-type on a body, authorization on
    // an authenticated call, idempotency-key on a create (UI-34).
    const response = await preflight(
      '/api/v1/products',
      'content-type,authorization,idempotency-key',
    );

    expect(response.status).toBe(204);
    const allowed = (response.headers['access-control-allow-headers'] ?? '')
      .split(',')
      .map((header) => header.trim().toLowerCase());

    expect(allowed).toContain('content-type');
    expect(allowed).toContain('authorization');
    // The one that was missing. Without it a product cannot be saved from the UI.
    expect(allowed).toContain('idempotency-key');
  });

  it('allows creating a party, which carries an operation id too', async () => {
    const response = await preflight('/api/v1/parties', 'content-type,authorization,idempotency-key');

    expect(response.status).toBe(204);
    expect((response.headers['access-control-allow-headers'] ?? '').toLowerCase()).toContain(
      'idempotency-key',
    );
  });

  it('answers only the configured web origin', async () => {
    const response = await preflight('/api/v1/products', 'content-type');

    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
  });
});
