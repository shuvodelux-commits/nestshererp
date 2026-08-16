import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { AppErrorFilter } from './common/app-error.filter';
import { loadConfig } from './config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new AppErrorFilter());
  // The Vue app is served from its own origin (the Vite dev server locally,
  // nginx in §6.5), so the browser preflights every mutating call.
  app.enableCors({ origin: config.webOrigin, allowedHeaders: ['content-type', 'authorization'] });
  await app.listen(config.port);
}

void bootstrap();
