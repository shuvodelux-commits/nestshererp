import { Catch } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';

import { ControlError, ControlErrorCode, statusFor } from './errors';

/**
 * One shape for every failure, and **no leaking of what went wrong internally**.
 *
 * An unexpected exception becomes a flat `INTERNAL_ERROR`. The temptation is to
 * pass the message through "just for debugging", and the reason not to is that
 * this API is reachable by every customer sidecar in the fleet: a stack trace
 * or a Postgres error text tells an attacker the schema, the driver and often
 * the query. The vendor reads the real reason in the process log, where it
 * belongs.
 */
@Catch()
export class ControlErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof ControlError) {
      response.status(statusFor(exception.code)).json({
        error: { code: exception.code, message: exception.message, details: exception.details ?? {} },
      });
      return;
    }

    process.stderr.write(
      `[control-plane] unhandled: ${exception instanceof Error ? exception.stack ?? exception.message : String(exception)}\n`,
    );
    response.status(500).json({
      error: { code: ControlErrorCode.INTERNAL_ERROR, message: 'Something went wrong', details: {} },
    });
  }
}
