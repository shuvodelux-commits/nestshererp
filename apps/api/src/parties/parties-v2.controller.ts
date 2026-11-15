import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { ManagePartiesService, PartyLedgerService, TenantContext } from '@sher/core-application';
import type { PartyLedgerResponse, PartyOpeningResponse, PartyReadV2, PartyReadV2ListResponse, PartyV2MutationReceiptEnvelope } from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  partyLedgerQuerySchema,
  partyLedgerResponseSchema,
  partyOpeningResponseSchema,
  partyQuerySchema,
  partyReadV2ListResponseSchema,
  partyReadV2Schema,
  partyV2CreateRequestSchema,
  partyV2MutationReceiptEnvelopeSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_PARTIES_SERVICE, PARTY_LEDGER_SERVICE } from './tokens';

/**
 * MOD-004 T09C-P2: strictly versioned, read-only Party transport.
 *
 * Public V1 is deliberately unchanged while legacy Vue and HisabIQ React
 * consumers still require its exact keys. V1 is a KNOWN privacy release
 * blocker (#72/#93): mounting this V2 route does NOT remediate that bypass.
 * Both V2 endpoints enforce grants in the application UoW, not client code.
 */
@Controller('api/v2/parties')
@UseGuards(TenantContextGuard)
export class PartiesV2Controller {
  constructor(
    @Inject(MANAGE_PARTIES_SERVICE) private readonly parties: ManagePartiesService,
    @Inject(PARTY_LEDGER_SERVICE) private readonly ledgers: PartyLedgerService,
  ) {}

  /** Directory-only creation, no historical opening or broader Party read grant. */
  @Post()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<PartyV2MutationReceiptEnvelope> {
    const parsed = partyV2CreateRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
        issues: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
      });
    }
    if (idempotencyKey === undefined ||
        !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(idempotencyKey)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Valid Idempotency-Key header is required');
    }
    return partyV2MutationReceiptEnvelopeSchema.parse({
      data: await this.parties.createV2({
        ctx, operationId: idempotencyKey, input: parsed.data,
      }),
    });
  }

  @Get()
  async list(
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<PartyReadV2ListResponse> {
    const parsed = partyQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidQuery(parsed.error.issues);
    // Fail closed if a future repository/service projection introduces
    // unexpected wire keys, a role mismatch or private fields while withheld.
    return partyReadV2ListResponseSchema.parse(
      await this.parties.listV2({ ctx, ...parsed.data }),
    );
  }

  /** Role-required versioned journal statement, never a Party-global net. */
  @Get(':id/ledger')
  async ledger(
    @Param('id') id: string,
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<PartyLedgerResponse> {
    const parsed = partyLedgerQuerySchema.required({ role: true }).safeParse(query);
    if (!parsed.success) throw invalidQuery(parsed.error.issues);
    return partyLedgerResponseSchema.parse(
      await this.ledgers.ledger({ ctx, partyId: id, ...parsed.data, readMode: 'SCOPED_V2' }),
    );
  }

  /** Read the historical source for exactly one selected trading relationship. */
  @Get(':id/opening')
  async opening(
    @Param('id') id: string,
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PartyOpeningResponse | null }> {
    const parsed = partyQuerySchema.pick({ role: true }).safeParse(query);
    if (!parsed.success) throw invalidQuery(parsed.error.issues);
    const opening = await this.parties.getOpening({
      ctx, partyId: id, role: parsed.data.role, readMode: 'SCOPED_V2',
    });
    return { data: opening === null ? null : partyOpeningResponseSchema.parse(opening) };
  }

  @Get(':id')
  async detail(
    @Param('id') id: string,
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: PartyReadV2 }> {
    // V2 requires a selected role even for a single-role identity. This keeps
    // the caller's intent explicit and prevents a later multi-role ambiguity.
    const parsed = partyQuerySchema.pick({ role: true }).safeParse(query);
    if (!parsed.success) throw invalidQuery(parsed.error.issues);
    return {
      data: partyReadV2Schema.parse(
        await this.parties.getV2({ ctx, partyId: id, role: parsed.data.role }),
      ),
    };
  }
}

/** Report invalid field names, never untrusted values or private Party data. */
function invalidQuery(issues: readonly { readonly path: readonly PropertyKey[] }[]): AppError {
  return new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request query', {
    issues: issues.map((issue) => issue.path.join('.')).join(', '),
  });
}
