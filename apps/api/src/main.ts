import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { AppErrorFilter } from './common/app-error.filter';
import { corsOptions } from './common/cors';
import { loadConfig } from './config';
import { validateBootConfig } from './deployment/boot-validation';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  // §4.4: boot-time validation is mandatory, and it runs **before** anything is
  // constructed. A deployment configured into one of the refused combinations
  // must never reach the point of answering a request.
  validateBootConfig(config);

  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new AppErrorFilter());
  // The Vue app is served from its own origin (the Vite dev server locally,
  // nginx in §6.5), so the browser preflights every mutating call. The allowed
  // header list lives in one place — see `corsOptions`.
  app.enableCors(corsOptions(config.webOrigin));
  await app.listen(config.port);
}

void bootstrap();
