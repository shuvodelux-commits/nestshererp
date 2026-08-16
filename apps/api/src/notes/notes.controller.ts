import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import type { CreateNoteService, GetNoteService, TenantContext } from '@sher/core-application';
import type { NoteResponse } from '@sher/core-contracts';
import { AppError, createNoteRequestSchema, ErrorCode } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { CREATE_NOTE_SERVICE, GET_NOTE_SERVICE } from './tokens';
import { Inject } from '@nestjs/common';

/**
 * Reference controller. Validate shape → build command → call use case → map
 * result. Nothing else: no `if` about business meaning, no repository call, no
 * calculation (R-B5).
 */
@Controller('api/v1/notes')
@UseGuards(TenantContextGuard)
export class NotesController {
  constructor(
    @Inject(CREATE_NOTE_SERVICE) private readonly createNote: CreateNoteService,
    @Inject(GET_NOTE_SERVICE) private readonly getNote: GetNoteService,
  ) {}

  @Post()
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: NoteResponse }> {
    const payload = parseBody(body);
    const operationId = parseOperationId(idempotencyKey);
    const data = await this.createNote.execute({ ctx, operationId, source: 'API', ...payload });
    return { data };
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @Ctx() ctx: TenantContext): Promise<{ data: NoteResponse }> {
    return { data: await this.getNote.execute(ctx, id) };
  }
}

function parseBody(body: unknown): { title: string; amountMinor: number; businessDate: string } {
  const parsed = createNoteRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'Invalid request body', {
      issues: parsed.error.issues.map((issue) => issue.path.join('.')).join(', '),
    });
  }
  return parsed.data;
}

/** `Idempotency-Key` and `operation_id` are one value under two names (§5.26). */
function parseOperationId(header: string | undefined): string {
  if (header === undefined || !Ulid.isValid(header)) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, 'Idempotency-Key header must be a ULID');
  }
  return header;
}
