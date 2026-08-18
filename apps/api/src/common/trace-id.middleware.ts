import type { NestMiddleware } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import type { Clock } from '@sher/shared-utils';
import { Ulid } from '@sher/shared-utils';
import type { NextFunction, Request, Response } from 'express';

import { CLOCK } from '../infrastructure/tokens';

/** The header the error envelope and the denial audit both read. */
export const TRACE_ID_HEADER = 'x-trace-id';

/**
 * One id per request, so a shopkeeper reading an error on screen and an
 * engineer reading the audit trail are looking at the same event.
 *
 * §5.26's error envelope has carried a `traceId` field since Phase 0, and §5.22
 * requires a permission denial to be recorded with one. Until now nothing set
 * it and every response carried an empty string — a field that is always blank
 * is worse than no field, because it looks like it works.
 *
 * A ULID rather than a UUID, for the same reason every id in SherERP is one:
 * it sorts by time, so trace ids from one incident group together in a log.
 *
 * Set on the **response** rather than kept in request-scoped state, because
 * that is where the error filter and the interceptor can both reach it without
 * either one having to be request-scoped.
 */
@Injectable()
export class TraceIdMiddleware implements NestMiddleware {
  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  use(_request: Request, response: Response, next: NextFunction): void {
    response.setHeader(TRACE_ID_HEADER, Ulid.generate(this.clock));
    next();
  }
}
