import { Body, Controller, Get, Headers, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import type {
  ReplayService,
  ResolveConflictService,
  SyncReadService,
  TenantContext,
} from '@sher/core-application';
import type {
  SyncConflictResponse,
  SyncPullResponse,
  SyncPushResponse,
  SyncStatusResponse,
} from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  resolveSyncConflictRequestSchema,
  syncConflictListQuerySchema,
  syncPullQuerySchema,
  syncPushRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { REPLAY_SERVICE, RESOLVE_CONFLICT_SERVICE, SYNC_READ_SERVICE } from './tokens';

/**
 * The wire the offline machine speaks (§5.23, Phase 12.4).
 *
 * Validate shape → call the use case → map the result (R-B5). Which operations
 * may be posted, in what order, by whom, and what to do with the ones the books
 * refuse are all decided in the application layer, exactly as they are for
 * every other module — this file knows nothing about sales, periods or lots.
 *
 * **A lapsed licence stops this wire like any other** (D-36). `push` and
 * `conflicts/:id/resolve` are the two endpoints here that put new business
 * documents into the books, and they are `POST`, so `ReadOnlyLicenseGuard`
 * refuses them in `READ_ONLY` with the same message the counter would get.
 * The reads below are `GET` and stay open in every state, because there is no
 * state in which a shop cannot read and export its own data.
 */
@Controller('api/v1/sync')
@UseGuards(TenantContextGuard)
export class SyncController {
  constructor(
    @Inject(REPLAY_SERVICE) private readonly replay: ReplayService,
    @Inject(SYNC_READ_SERVICE) private readonly reads: SyncReadService,
    @Inject(RESOLVE_CONFLICT_SERVICE) private readonly conflicts: ResolveConflictService,
  ) {}

  /**
   * Everything the machine has been holding.
   *
   * Answers per operation rather than for the batch: a day with one refused
   * sale in it is a day with one refused sale in it, and the other forty go
   * into the books (§14 — no gaps, no duplicates, no reordered dependencies).
   */
  @Post('push')
  async push(@Body() body: unknown, @Ctx() ctx: TenantContext): Promise<SyncPushResponse> {
    const parsed = syncPushRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That is not something this shop can accept');
    }
    return this.replay.push(ctx, parsed.data);
  }

  /** What has changed in the shop's master data since this machine last looked. */
  @Get('pull')
  async pull(
    @Query() query: unknown,
    @Headers('x-device-key') deviceKey: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<SyncPullResponse> {
    const parsed = syncPullQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid sync request');
    if (deviceKey === undefined || deviceKey === '') {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'This computer did not say which it is');
    }
    return this.reads.pull(ctx, deviceKey, parsed.data);
  }

  @Get('status')
  async status(@Ctx() ctx: TenantContext): Promise<SyncStatusResponse> {
    return this.reads.status(ctx);
  }

  @Get('conflicts')
  async conflictList(
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: readonly SyncConflictResponse[] }> {
    const parsed = syncConflictListQuerySchema.safeParse(query);
    if (!parsed.success) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid sync issue query');
    return this.reads.conflicts(ctx, parsed.data);
  }

  /**
   * A person's decision about one refused operation.
   *
   * Retry, merge and keep-both all go back through the service that refused it,
   * against live state — so nothing here can post what the counter could not
   * have posted online. Discarding posts nothing and erases nothing.
   */
  @Post('conflicts/:id/resolve')
  async resolve(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: SyncConflictResponse }> {
    if (id.length !== 26) throw new AppError(ErrorCode.NOT_FOUND, 'That sync issue is not here');
    const parsed = resolveSyncConflictRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'That is not a decision this screen can take');
    }
    return {
      data: await this.conflicts.resolve({ ctx, conflictId: id, request: parsed.data }),
    };
  }
}
