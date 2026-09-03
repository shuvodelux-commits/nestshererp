import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException } from '@nestjs/common';
import { AppError, ErrorCode, httpStatusFor } from '@sher/core-contracts';
import type { Clock } from '@sher/shared-utils';
import type { Request, Response } from 'express';

import { diagnosticsBuffer } from '../management/diagnostics-buffer';

/**
 * Maps errors to the envelope in §5.26: `{ error: { code, message, details, traceId } }`.
 *
 * Three kinds of error reach this filter, and conflating them is how a missing
 * route gets reported to a shopkeeper as "internal error":
 *
 *  1. `AppError` — a decision the application layer made. Reported as-is.
 *  2. `HttpException` — the framework's own refusal: no such route, a body that
 *     is not JSON, a payload too large. These carry a real status that must
 *     survive, otherwise every 404 becomes a 500 and nobody can tell a stale
 *     deployment from a broken one.
 *  3. Anything else — genuinely unexpected. 500, and the cause is written to
 *     stderr so it is diagnosable, but **never** put in the response: a leaked
 *     query string is a tenant-isolation problem, not just noise.
 */
@Catch()
export class AppErrorFilter implements ExceptionFilter {
  /**
   * The clock is passed in rather than injected because this filter is
   * constructed by hand in `main.ts`, before the Nest container exists — and
   * R-C8 has no exemption for that. Optional so a caller that has no use for
   * diagnostics (a test harness, a future embedding) is not forced to invent one.
   */
  constructor(private readonly clock?: Clock) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request>();
    const traceId = response.getHeader('x-trace-id')?.toString() ?? '';

    /*
     * Phase 17 (§7): every failure is also recorded as a structured diagnostic
     * for the management agent to collect.
     *
     * **A code, a route pattern and a status. Never the message.** This filter
     * already knows that an exception's own text can echo a fragment of the
     * payload — the comment on `HttpException` below says so, and the payload
     * may be a password. The same reasoning forbids shipping that text to the
     * vendor's server, so the buffer has nowhere to put it: redaction is
     * structural rather than a pattern list somebody has to keep current.
     */
    recordDiagnostic(exception, request, traceId, this.clock);

    if (exception instanceof AppError) {
      this.send(
        response,
        httpStatusFor(exception.code),
        exception.code,
        exception.message,
        traceId,
        exception.details,
      );
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = CODE_FOR_STATUS[status] ?? ErrorCode.INTERNAL_ERROR;
      // A **static** message per status, never the exception's own. Express
      // reports a malformed body as `Unexpected token … in JSON at position 3`,
      // which can echo a fragment of the payload — and the payload may be a
      // password.
      this.send(response, status, code, MESSAGE_FOR_STATUS[status] ?? 'Request rejected', traceId);
      return;
    }

    // Server-side only. `no-console` is a lint error, so this uses the same
    // stream-writing style as the migration runner. No timestamp: `new Date()`
    // is banned outside the Clock implementation (R-C8) and the log collector
    // stamps lines anyway.
    const where = traceId === '' ? '' : ` traceId=${traceId}`;
    process.stderr.write(`unhandled error${where}: ${describe(exception)}\n`);

    this.send(response, 500, ErrorCode.INTERNAL_ERROR, 'Internal error', traceId);
  }

  private send(
    response: Response,
    status: number,
    code: ErrorCode,
    message: string,
    traceId: string,
    details?: Readonly<Record<string, string>>,
  ): void {
    response.status(status).json({ error: { code, message, details: details ?? {}, traceId } });
  }
}

/**
 * Framework refusals mapped onto the closed code list in §5.26. A status with no
 * entry here is not a decision this application made, so it stays INTERNAL_ERROR.
 */
const CODE_FOR_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: ErrorCode.VALIDATION_FAILED,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.PERMISSION_DENIED,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT_STALE_VERSION,
};

const MESSAGE_FOR_STATUS: Readonly<Record<number, string>> = {
  400: 'The request could not be read',
  401: 'Not signed in',
  403: 'Not allowed',
  404: 'No such endpoint',
  409: 'That conflicts with the current state',
};

/**
 * One diagnostic event, carrying only what identifies the bug.
 *
 * The route is the *pattern* where Nest knows one — `/api/v1/purchases/:id`
 * rather than `/api/v1/purchases/01J8Z…`. The pattern says where the fault is;
 * the resolved path names a customer's document and adds nothing about the
 * fault. §7 and §22, enforced at the one place every failure passes through.
 */
function recordDiagnostic(
  exception: unknown,
  request: Request,
  traceId: string,
  clock: Clock | undefined,
): void {
  if (clock === undefined) return;
  const code =
    exception instanceof AppError
      ? exception.code
      : exception instanceof HttpException
        ? (CODE_FOR_STATUS[exception.getStatus()] ?? ErrorCode.INTERNAL_ERROR)
        : ErrorCode.INTERNAL_ERROR;
  const status =
    exception instanceof AppError
      ? httpStatusFor(exception.code)
      : exception instanceof HttpException
        ? exception.getStatus()
        : 500;

  // Validation and permission refusals are the shop using the software, not the
  // software failing. Reporting them would drown the signal the vendor needs in
  // a shop's ordinary typing mistakes.
  if (status < 500 && status !== 409 && status !== 412) return;

  const route = routePatternOf(request);
  diagnosticsBuffer.record({
    code,
    module: route.split('/')[3] ?? '',
    route,
    http_status: status,
    correlation_id: traceId,
    app_version: process.env['APP_VERSION'] ?? '',
    schema_version: '',
    occurred_at: clock.now().toISOString(),
  });
}

/**
 * The route pattern, with ids replaced by a placeholder.
 *
 * Nest exposes the matched route on the underlying express request, but only
 * once routing has succeeded — a 404 has none. Falling back to a substitution
 * keeps a resolved id out of the record either way.
 */
function routePatternOf(request: Request): string {
  const matched = (request as Request & { route?: { path?: string } }).route?.path;
  if (typeof matched === 'string' && matched !== '') return matched;
  const path = (request.originalUrl ?? request.url ?? '').split('?')[0] ?? '';
  return path.replace(/\/[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}/gu, '/:id').replace(/\/\d+/gu, '/:id');
}

/** Stack where there is one, so an unexpected failure is actually traceable. */
function describe(exception: unknown): string {
  if (exception instanceof Error) return exception.stack ?? `${exception.name}: ${exception.message}`;
  return String(exception);
}
