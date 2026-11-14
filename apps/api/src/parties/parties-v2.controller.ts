import {
  Controller,
  Get,
  Inject,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { ManagePartiesService, TenantContext } from '@sher/core-application';
import type { PartyReadV2, PartyReadV2ListResponse } from '@sher/core-contracts';
import {
  AppError,
  ErrorCode,
  partyQuerySchema,
  partyReadV2ListResponseSchema,
  partyReadV2Schema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { MANAGE_PARTIES_SERVICE } from './tokens';

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
  ) {}

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
