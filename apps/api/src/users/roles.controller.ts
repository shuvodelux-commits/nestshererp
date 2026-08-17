import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { ManageRolesService, TenantContext } from '@sher/core-application';
import type { RoleDetailResponse, RoleListResponse } from '@sher/core-contracts';
import {
  AppError,
  createRoleRequestSchema,
  deleteRoleRequestSchema,
  ErrorCode,
  updateRoleRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_ROLES_SERVICE } from './tokens';

/**
 * Roles and what they may do (slice 1.4, §5.26).
 *
 * `DELETE` carries a body, unusually, because deleting a role is a step-up
 * action and the password has to travel with it. The alternative — a password
 * in the query string — would put it in the server log.
 */
@Controller('api/v1/roles')
@UseGuards(TenantContextGuard)
export class RolesController {
  constructor(@Inject(MANAGE_ROLES_SERVICE) private readonly roles: ManageRolesService) {}

  @Get()
  async list(@Ctx() ctx: TenantContext): Promise<{ data: RoleListResponse }> {
    return { data: await this.roles.list({ ctx }) };
  }

  @Post()
  async create(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: RoleDetailResponse }> {
    const parsed = createRoleRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.roles.create({ ctx, ...parsed.data }) };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: RoleDetailResponse }> {
    const parsed = updateRoleRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.roles.update({ ctx, roleId: id, ...parsed.data }) };
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<void> {
    const parsed = deleteRoleRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    await this.roles.remove({ ctx, roleId: id, ...parsed.data });
  }
}

/** Field names only — a validation message must never echo a password back. */
function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
