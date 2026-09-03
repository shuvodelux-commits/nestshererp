import { Body, Controller, Get, Inject, Param, Post, Put, UseGuards } from '@nestjs/common';
import { issueSeveritySchema, issueStatusSchema } from '@sher/control-contracts';
import { z } from 'zod';

import { ControlError, ControlErrorCode } from '../common/errors';
import { Operator, OperatorGuard, RequirePermission } from '../operators/operator.guard';
import type { OperatorPrincipal } from '../operators/operator.guard';
import type { IssuesService } from './issues.service';
import { ISSUES_SERVICE } from '../tokens';

const createSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(5000).default(''),
    affectedFromVersion: z.string().min(1).max(40),
    affectedToVersion: z.string().min(1).max(40),
    affectedSchemaVersion: z.string().max(64).default(''),
    severity: issueSeveritySchema.default('MEDIUM'),
    workaround: z.string().max(2000).default(''),
    fixedInVersion: z.string().max(40).default(''),
    status: issueStatusSchema.default('OPEN'),
  })
  .strict();

@Controller('api/control/known-issues')
@UseGuards(OperatorGuard)
export class IssuesController {
  constructor(@Inject(ISSUES_SERVICE) private readonly issues: IssuesService) {}

  @Get()
  @RequirePermission('issue.view')
  async list(): Promise<unknown> {
    return { issues: await this.issues.list() };
  }

  /** The list behind "17 installations potentially affected" (§8). */
  @Get(':id/affected')
  @RequirePermission('issue.view')
  async affected(@Param('id') id: string): Promise<unknown> {
    return { installations: await this.issues.affected(id) };
  }

  @Post()
  @RequirePermission('issue.manage')
  async create(@Body() body: unknown, @Operator() operator: OperatorPrincipal): Promise<unknown> {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'A title and an affected version range');
    }
    return this.issues.create(parsed.data, operator);
  }

  @Put(':id')
  @RequirePermission('issue.manage')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Operator() operator: OperatorPrincipal,
  ): Promise<{ ok: true }> {
    const parsed = z
      .object({
        status: issueStatusSchema.optional(),
        fixedInVersion: z.string().max(40).optional(),
        workaround: z.string().max(2000).optional(),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new ControlError(ControlErrorCode.VALIDATION_FAILED, 'Nothing to change');
    await this.issues.update(
      id,
      {
        ...(parsed.data.status === undefined ? {} : { status: parsed.data.status }),
        ...(parsed.data.fixedInVersion === undefined ? {} : { fixedInVersion: parsed.data.fixedInVersion }),
        ...(parsed.data.workaround === undefined ? {} : { workaround: parsed.data.workaround }),
      },
      operator,
    );
    return { ok: true };
  }
}
