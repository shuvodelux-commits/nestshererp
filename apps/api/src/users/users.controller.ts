import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { ManageUsersService, TenantContext } from '@sher/core-application';
import type { UserListResponse, UserResponse } from '@sher/core-contracts';
import {
  AppError,
  createUserRequestSchema,
  ErrorCode,
  setUserDisabledRequestSchema,
  updateUserRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_USERS_SERVICE } from './tokens';

/**
 * The people who work in a business (slice 1.3, §5.3).
 *
 * Validate shape → call use case → map result (R-B5). Every decision about who
 * may do this, whether the step-up password is right, and whether the last Owner
 * is being removed lives in the use case — a guard cannot see any of it.
 *
 * Disabling is `POST /{id}/disabled`, an explicit action, not a PATCH on a
 * status field (§5.26): it revokes sessions and is refused for the last Owner,
 * so it runs its own use case.
 */
@Controller('api/v1/users')
@UseGuards(TenantContextGuard)
export class UsersController {
  constructor(@Inject(MANAGE_USERS_SERVICE) private readonly users: ManageUsersService) {}

  @Get()
  async list(@Ctx() ctx: TenantContext): Promise<{ data: UserListResponse }> {
    return { data: await this.users.list({ ctx }) };
  }

  @Post()
  async create(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: UserResponse }> {
    const parsed = createUserRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.users.create({ ctx, ...parsed.data }) };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: UserResponse }> {
    const parsed = updateUserRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.users.update({ ctx, userId: id, ...parsed.data }) };
  }

  /** 200, not 201: this changes a user, it does not create one. */
  @Post(':id/disabled')
  @HttpCode(200)
  async setDisabled(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: UserResponse }> {
    const parsed = setUserDisabledRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.users.setDisabled({ ctx, userId: id, ...parsed.data }) };
  }
}

/** Field names only — a validation message must never echo a password back. */
function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
