import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import type { Request } from 'express';

import { ControlPlaneModule } from './app.module';
import { ControlErrorFilter } from './common/error.filter';
import { controlSecurityHeaders } from './common/security-headers';
import { loadConfig, validateBootConfig } from './config';
import type { TunnelRegistry } from './support/tunnel-registry';
import { TUNNEL_REGISTRY } from './tokens';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  // Refusals happen before anything is constructed, exactly as the ERP does it:
  // a control plane configured into one of the banned states must never reach
  // the point of answering a request.
  validateBootConfig(config);

  const app = await NestFactory.create<NestExpressApplication>(ControlPlaneModule, { bodyParser: false });

  /*
   * The raw body is kept because agent signatures cover a hash of it.
   *
   * Re-serialising the parsed object would give a different byte string than
   * the one the shop signed — different key order, different number formatting —
   * and every signature would fail on a message nobody had touched. This is the
   * one place in the process where "what actually arrived" is the thing that
   * matters, so it is captured before anything can normalise it.
   */
  app.use(
    express.json({
      limit: '25mb',
      verify: (req: Request & { rawBody?: Buffer }, _res, buffer: Buffer) => {
        req.rawBody = Buffer.from(buffer);
      },
    }),
  );
  app.use(controlSecurityHeaders);
  app.useGlobalFilters(new ControlErrorFilter());
  app.enableCors({
    origin: config.consoleOrigin,
    credentials: false,
    allowedHeaders: ['content-type', 'authorization'],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.listen(config.port);

  /*
   * The tunnel server rides on the HTTP server Nest already made, on a path of
   * its own. It has to be attached after `listen` because that is when the
   * underlying server exists — and it authenticates at the upgrade handshake,
   * so an unauthorised socket is refused before it is ever a socket (§16).
   */
  app.get<TunnelRegistry>(TUNNEL_REGISTRY).attach(app.getHttpServer());

  process.stdout.write(`Control plane listening on ${String(config.port)}\n`);
}

void bootstrap();
