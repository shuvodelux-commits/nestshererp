import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
});

it('GET /health returns 200 with status ok', async () => {
  const response = await request(app.getHttpServer()).get('/health');

  expect(response.status).toBe(200);
  expect(response.body).toEqual({ status: 'ok' });
});
