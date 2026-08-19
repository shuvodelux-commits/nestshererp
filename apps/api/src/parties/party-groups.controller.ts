import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { ManagePartyGroupsService, TenantContext } from '@sher/core-application';
import type {
  PartySetupResponse,
  RemoveCatalogEntryResponse,
} from '@sher/core-contracts';
import { AppError, ErrorCode, saveCustomerGroupRequestSchema } from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_PARTY_GROUPS_SERVICE } from './tokens';

/**
 * Customer groups, and the one call the parties screens make before they draw
 * (§5.6, §5.21).
 *
 * Separate from `/api/v1/parties` so `GET /api/v1/parties/:id` cannot swallow a
 * setup request as a party id — one route, one meaning.
 */
@Controller('api/v1/party-setup')
@UseGuards(TenantContextGuard)
export class PartyGroupsController {
  constructor(
    @Inject(MANAGE_PARTY_GROUPS_SERVICE) private readonly groups: ManagePartyGroupsService,
  ) {}

  @Get()
  async setup(@Ctx() ctx: TenantContext): Promise<{ data: PartySetupResponse }> {
    return { data: await this.groups.setup({ ctx }) };
  }

  @Post('groups')
  async create(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PartySetupResponse }> {
    const parsed = saveCustomerGroupRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.groups.create({ ctx, name: parsed.data.name }) };
  }

  @Patch('groups/:id')
  async rename(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PartySetupResponse }> {
    const parsed = saveCustomerGroupRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.groups.rename({ ctx, groupId: id, name: parsed.data.name }) };
  }

  /**
   * Deleted when nothing is filed under it, archived when something is — the
   * caller is told which, because they are different promises (§3.6).
   */
  @Delete('groups/:id')
  async remove(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: RemoveCatalogEntryResponse }> {
    return { data: await this.groups.remove({ ctx, groupId: id }) };
  }
}

function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
