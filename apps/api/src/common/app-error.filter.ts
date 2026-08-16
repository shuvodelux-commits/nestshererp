import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException } from '@nestjs/common';
import { AppError, ErrorCode, httpStatusFor } from '@sher/core-contracts';
import type { Response } from 'express';

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
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const traceId = response.getHeader('x-trace-id')?.toString() ?? '';

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

/** Stack where there is one, so an unexpected failure is actually traceable. */
function describe(exception: unknown): string {
  if (exception instanceof Error) return exception.stack ?? `${exception.name}: ${exception.message}`;
  return String(exception);
}
