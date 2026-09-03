/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers endpoint:GET /api/v1/dashboard/summary
 * @covers endpoint:POST /api/v1/auth/login
 */
import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { AppErrorFilter } from '../src/common/app-error.filter';

/**
 * The error envelope (§5.26).
 *
 * These exist because a stale API build reported every missing route as
 * `INTERNAL_ERROR`, which is indistinguishable from a broken server: the owner
 * hit it on Settings → Security and had no way to tell that the deployment was
 * simply out of date. A framework refusal must keep its own status.
 */
let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AppErrorFilter());
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe('the error envelope', () => {
  it('reports an unknown route as 404 NOT_FOUND, never 500', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/settings/security/does-not-exist')
      .send({});

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toBe('No such endpoint');
  });

  it('reports an unreadable body as 400, without echoing the body back', async () => {
    // The payload is malformed *and* contains something password-shaped: Express
    // reports the parse failure with a fragment of the input, and that fragment
    // must never reach the response.
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('content-type', 'application/json')
      .send('{"password":"Sup3rSecret" ');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(response.body)).not.toContain('Sup3rSecret');
  });

  it('reports a missing bearer token as 401, from the guard, unchanged', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/dashboard/summary');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('always answers in the §5.26 envelope', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/nope');

    expect(Object.keys(response.body)).toEqual(['error']);
    expect(Object.keys(response.body.error).sort()).toEqual([
      'code',
      'details',
      'message',
      'traceId',
    ]);
  });
});
