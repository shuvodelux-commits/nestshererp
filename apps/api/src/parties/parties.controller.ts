import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  ManagePartiesService,
  PartyLedgerService,
  TenantContext,
} from '@sher/core-application';
import type {
  PartyLedgerResponse,
  PartyListResponse,
  PartyOpeningResponse,
  PartyResponse,
} from '@sher/core-contracts';
import {
  AppError,
  correctOpeningBalanceRequestSchema,
  ErrorCode,
  openingBalanceRequestSchema,
  partyLedgerQuerySchema,
  partyQuerySchema,
  partyRoleSchema,
  savePartyRequestSchema,
  setPartyStatusRequestSchema,
  updatePartyRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_PARTIES_SERVICE, PARTY_LEDGER_SERVICE } from './tokens';

/**
 * Parties — customers, suppliers and vendors (Phase 2, §5.6, D-04).
 *
 * Validate shape → build command → call use case → map result (R-B5). Which
 * roles the caller may create, whether vendors exist for this shop at all, and
 * whether the version is still current are decided in the use case.
 *
 * `Idempotency-Key` is the transport for `operation_id`: the same value under
 * two names (§5.26).
 */
@Controller('api/v1/parties')
@UseGuards(TenantContextGuard)
export class PartiesController {
  constructor(
    @Inject(MANAGE_PARTIES_SERVICE) private readonly parties: ManagePartiesService,
    @Inject(PARTY_LEDGER_SERVICE) private readonly ledgers: PartyLedgerService,
  ) {}

  @Get()
  async list(@Query() query: unknown, @Ctx() ctx: TenantContext): Promise<PartyListResponse> {
    const parsed = partyQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return this.parties.list({ ctx, ...parsed.data });
  }

  @Get(':id')
  async get(@Param('id') id: string, @Ctx() ctx: TenantContext): Promise<{ data: PartyResponse }> {
    return { data: await this.parties.get({ ctx, partyId: id }) };
  }

  /**
   * A party's statement (§2.4, INV-06).
   *
   * Read-only and permission-checked against the party's own roles in the use
   * case — the trust that shows a customer is the trust that shows their
   * ledger.
   */
  @Get(':id/ledger')
  async ledger(
    @Param('id') id: string,
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<PartyLedgerResponse> {
    const parsed = partyLedgerQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return this.ledgers.ledger({ ctx, partyId: id, ...parsed.data });
  }

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PartyResponse }> {
    const parsed = savePartyRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    if (idempotencyKey === undefined || idempotencyKey.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Idempotency-Key header is required');
    }

    return {
      data: await this.parties.create({
        ctx,
        operationId: idempotencyKey,
        input: { ...parsed.data },
      }),
    };
  }

  /**
   * The opening balance posted for a role, or `null` when there is none.
   *
   * Its own call rather than a field on the party, because the list would then
   * carry a join every page for a figure only the correction dialog reads.
   */
  @Get(':id/opening')
  async opening(
    @Param('id') id: string,
    @Query('role') role: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PartyOpeningResponse | null }> {
    const parsed = partyRoleSchema.safeParse(role);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return { data: await this.parties.getOpening({ ctx, partyId: id, role: parsed.data }) };
  }

  /**
   * Sets an opening balance on a party created without one (§5.6).
   *
   * Idempotent on the same header a party create uses: it posts a journal
   * entry, and a retried request must not open the same balance twice.
   */
  @Post(':id/opening')
  async setOpening(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PartyOpeningResponse }> {
    const parsed = openingBalanceRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    if (idempotencyKey === undefined || idempotencyKey.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Idempotency-Key header is required');
    }

    return {
      data: await this.parties.setOpening({
        ctx,
        partyId: id,
        operationId: idempotencyKey,
        opening: { ...parsed.data },
      }),
    };
  }

  /** Corrects a posted opening: reversal and repost, never an edit (§2.5). */
  @Patch(':id/opening')
  async correctOpening(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PartyOpeningResponse }> {
    const parsed = correctOpeningBalanceRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    if (idempotencyKey === undefined || idempotencyKey.length !== 26) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Idempotency-Key header is required');
    }

    const { version, ...opening } = parsed.data;
    return {
      data: await this.parties.correctOpening({
        ctx,
        partyId: id,
        operationId: idempotencyKey,
        version,
        opening,
      }),
    };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PartyResponse }> {
    const parsed = updatePartyRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    const { version, ...input } = parsed.data;
    return { data: await this.parties.update({ ctx, partyId: id, version, input }) };
  }

  /** 200, not 201: this changes a party, it does not create one. */
  @Post(':id/status')
  @HttpCode(200)
  async setStatus(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PartyResponse }> {
    const parsed = setPartyStatusRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);
    return { data: await this.parties.setStatus({ ctx, partyId: id, ...parsed.data }) };
  }

  /** Only ever succeeds for a party nothing refers to (§3.6). */
  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id') id: string, @Ctx() ctx: TenantContext): Promise<void> {
    await this.parties.deleteParty({ ctx, partyId: id });
  }
}

/** Field names only — a validation message never echoes a value back. */
function invalidBody(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
