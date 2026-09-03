import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { permissionsOf } from '@sher/control-contracts';
import type { Request } from 'express';
import { z } from 'zod';

import { ControlError, ControlErrorCode } from '../common/errors';
import { AllowUnenrolled, Operator, OperatorGuard, RequirePermission } from './operator.guard';
import type { OperatorPrincipal } from './operator.guard';
import type { OperatorsService } from './operators.service';
import { OPERATORS_SERVICE } from '../tokens';

const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1).max(300),
    /** Empty on the first login of an operator who has not enrolled yet. */
    code: z.string().max(10).default(''),
  })
  .strict();

const codeSchema = z.object({ code: z.string().min(6).max(10) }).strict();

const createSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).max(120),
    password: z.string().min(12).max(300),
    role: z.string().min(1).max(40),
  })
  .strict();

/**
 * Sign in, enrol a second factor, re-authenticate, and manage operators.
 *
 * Validate shape → call the service → map the result, the same house rule the
 * ERP's controllers follow (R-B5). No policy lives here: whether a role may do
 * a thing is `ROLE_PERMISSIONS`, and whether an action needs a fresh code is
 * `REAUTH_ACTIONS`.
 */
@Controller('api/control/operators')
export class OperatorsController {
  constructor(@Inject(OPERATORS_SERVICE) private readonly operators: OperatorsService) {}

  @Post('login')
  async login(@Body() body: unknown, @Req() request: Request): Promise<unknown> {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Check the details and try again');
    }
    return this.operators.login({
      ...parsed.data,
      ip: String(request.headers['x-forwarded-for'] ?? request.ip ?? ''),
      userAgent: String(request.headers['user-agent'] ?? ''),
    });
  }

  /** Reachable before enrolment is finished, and deliberately the only thing that is. */
  @Post('enrol')
  @UseGuards(OperatorGuard)
  @AllowUnenrolled()
  async enrol(@Body() body: unknown, @Operator() operator: OperatorPrincipal): Promise<{ ok: true }> {
    const parsed = codeSchema.safeParse(body);
    if (!parsed.success) throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Enter the 6-digit code');
    await this.operators.completeEnrolment(operator.id, parsed.data.code);
    return { ok: true };
  }

  /** The fresh-code step in front of every action §24 calls sensitive. */
  @Post('reauth')
  @UseGuards(OperatorGuard)
  async reauth(@Body() body: unknown, @Operator() operator: OperatorPrincipal): Promise<{ ok: true }> {
    const parsed = codeSchema.safeParse(body);
    if (!parsed.success) throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Enter the 6-digit code');
    await this.operators.reauthenticate(operator.id, operator.sessionId, parsed.data.code);
    return { ok: true };
  }

  @Post('logout')
  @UseGuards(OperatorGuard)
  @AllowUnenrolled()
  async logout(@Operator() operator: OperatorPrincipal): Promise<{ ok: true }> {
    await this.operators.logout(operator.sessionId);
    return { ok: true };
  }

  /** Who am I, and what may I do — what the console renders its navigation from. */
  @Get('me')
  @UseGuards(OperatorGuard)
  @AllowUnenrolled()
  me(@Operator() operator: OperatorPrincipal): unknown {
    return {
      id: operator.id,
      name: operator.name,
      email: operator.email,
      role: operator.role,
      totpEnrolled: operator.totpEnrolled,
      permissions: permissionsOf(operator.role),
      reauthAt: operator.reauthAt,
    };
  }

  @Get()
  @UseGuards(OperatorGuard)
  @RequirePermission('operator.manage')
  async list(): Promise<unknown> {
    return { operators: await this.operators.list() };
  }

  @Post()
  @UseGuards(OperatorGuard)
  @RequirePermission('operator.manage')
  async create(@Body() body: unknown, @Operator() operator: OperatorPrincipal): Promise<unknown> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new ControlError(
        ControlErrorCode.VALIDATION_FAILED,
        'A name, an email, a role and a password of at least 12 characters',
      );
    }
    return this.operators.create({ ...parsed.data, actor: { id: operator.id, name: operator.name } });
  }
}
