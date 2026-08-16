import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch } from '@nestjs/common';
import { AppError, ErrorCode, httpStatusFor } from '@sher/core-contracts';
import type { Response } from 'express';

/**
 * Maps errors to the envelope in §5.26: `{ error: { code, message, details, traceId } }`.
 * An unexpected error becomes INTERNAL_ERROR with no stack trace and no SQL —
 * a leaked query string is a tenant-isolation problem, not just noise.
 */
@Catch()
export class AppErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const traceId = response.getHeader('x-trace-id')?.toString() ?? '';

    if (exception instanceof AppError) {
      response.status(httpStatusFor(exception.code)).json({
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details ?? {},
          traceId,
        },
      });
      return;
    }

    response.status(500).json({
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'Internal error',
        details: {},
        traceId,
      },
    });
  }
}
