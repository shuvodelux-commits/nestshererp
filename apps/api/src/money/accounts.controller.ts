import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  DailyCashService,
  ManageAccountsService,
  TenantContext,
} from '@sher/core-application';
import type {
  AccountStatementResponse,
  MoneyAccountListResponse,
  MoneyAccountResponse,
} from '@sher/core-contracts';
import {
  accountListQuerySchema,
  accountStatementQuerySchema,
  accountVersionRequestSchema,
  AppError,
  createMoneyAccountRequestSchema,
  ErrorCode,
  updateMoneyAccountRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { DAILY_CASH_SERVICE, MANAGE_ACCOUNTS_SERVICE } from './tokens';

/**
 * Cash, bank and MFS accounts, and their statements (Phase 4, §5.16, §5.17).
 *
 * Validate shape → build command → call use case → map result (R-B5). Which
 * accounts the caller may see, whether the bank feature is on, and whether an
 * account is empty enough to retire are all decided in the use case.
 */
@Controller('api/v1/money/accounts')
@UseGuards(TenantContextGuard)
export class AccountsController {
  constructor(
    @Inject(MANAGE_ACCOUNTS_SERVICE) private readonly accounts: ManageAccountsService,
    @Inject(DAILY_CASH_SERVICE) private readonly daily: DailyCashService,
  ) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<MoneyAccountListResponse> {
    const parsed = accountListQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return this.accounts.list({ ctx, ...parsed.data });
  }

  /**
   * One account's ledger — the same endpoint the statement always was, now
   * carrying the Finance ledger's search and family filter (§5.17).
   *
   * Which accounts this caller may read is decided in the use case, not here:
   * the route is reachable by typing it, so the check has to live below the
   * menu that hid it.
   */
  @Get(':id/statement')
  async statement(
    @Param('id') id: string,
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<AccountStatementResponse> {
    const parsed = accountStatementQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return this.daily.statement({ ctx, accountId: id, ...parsed.data });
  }

  @Post()
  async create(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: MoneyAccountResponse }> {
    const parsed = createMoneyAccountRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    const { operationId, ...input } = parsed.data;
    return { data: await this.accounts.create({ ctx, operationId, input }) };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: MoneyAccountResponse }> {
    const parsed = updateMoneyAccountRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    const { version, ...input } = parsed.data;
    return {
      data: await this.accounts.update({ ctx, accountId: id, expectedVersion: version, input }),
    };
  }

  /** 200, not 201: this retires an account, it does not create one (§3.6). */
  @Post(':id/deactivate')
  @HttpCode(200)
  async deactivate(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: MoneyAccountResponse }> {
    const parsed = accountVersionRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return {
      data: await this.accounts.deactivate({
        ctx,
        accountId: id,
        expectedVersion: parsed.data.version,
      }),
    };
  }
}

/** Field names only — a validation message never echoes a value back. */
export function invalidBody(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
