import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  ImportStatementService,
  ReconcileAccountService,
  TenantContext,
} from '@sher/core-application';
import type {
  ReconciliationListResponse,
  ReconciliationWorkspaceResponse,
  StatementPreviewResponse,
} from '@sher/core-contracts';
import {
  completeReconciliationRequestSchema,
  confirmStatementRequestSchema,
  reconciliationListQuerySchema,
  reopenReconciliationRequestSchema,
  saveMatchRequestSchema,
  startReconciliationRequestSchema,
  uploadStatementRequestSchema,
} from '@sher/core-contracts';

import { Ctx, TenantContextGuard } from '../auth/tenant-context.guard';
import { invalidBody } from './accounts.controller';
import { IMPORT_STATEMENT_SERVICE, RECONCILE_ACCOUNT_SERVICE } from './tokens';

/**
 * Reconciling a bank or MFS account against its statement (Phase 11, §5.17).
 *
 * Validate shape → build command → call use case → map result (R-B5). Which
 * accounts may be reconciled, what may be matched and when a reconciliation may
 * be signed off are decided in the use case, not here.
 *
 * Every route on this controller either reads or moves a **link**. There is no
 * endpoint that posts, corrects, re-dates or cancels a transaction — those live
 * on the controllers of the modules that own those documents, which is where
 * the screen sends the owner.
 */
@Controller('api/v1/money/reconciliations')
@UseGuards(TenantContextGuard)
export class ReconciliationsController {
  constructor(
    @Inject(RECONCILE_ACCOUNT_SERVICE) private readonly reconcile: ReconcileAccountService,
    @Inject(IMPORT_STATEMENT_SERVICE) private readonly statements: ImportStatementService,
  ) {}

  @Get()
  async list(
    @Query() query: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<ReconciliationListResponse> {
    const parsed = reconciliationListQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return this.reconcile.list({ ctx, accountId: parsed.data.accountId ?? null });
  }

  @Get(':id')
  async workspace(
    @Param('id') id: string,
    @Ctx() ctx: TenantContext,
  ): Promise<ReconciliationWorkspaceResponse> {
    return this.reconcile.workspace({ ctx, reconciliationId: id });
  }

  @Post()
  async start(
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ReconciliationWorkspaceResponse }> {
    const parsed = startReconciliationRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return { data: await this.reconcile.start({ ctx, ...parsed.data }) };
  }

  /** The PDF arrives base64 in the body, the way the CSV import does (§5.6). */
  @Post(':id/statement')
  @HttpCode(200)
  async upload(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: StatementPreviewResponse }> {
    const parsed = uploadStatementRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return {
      data: await this.statements.upload({
        ctx,
        reconciliationId: id,
        fileName: parsed.data.fileName,
        content: new Uint8Array(Buffer.from(parsed.data.contentBase64, 'base64')),
      }),
    };
  }

  /** Importing the rows the owner read and, where needed, repaired. */
  @Post(':id/statement/confirm')
  @HttpCode(200)
  async confirm(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ReconciliationWorkspaceResponse }> {
    const parsed = confirmStatementRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return {
      data: await this.statements.confirm({
        ctx,
        reconciliationId: id,
        fileId: parsed.data.fileId,
        lines: parsed.data.lines,
      }),
    };
  }

  /**
   * `View Original Statement` — the file exactly as it was uploaded.
   *
   * Streamed rather than described: §5.17 keeps the PDF as the evidence a
   * reconciliation rests on, and evidence you cannot open is not evidence.
   */
  @Get(':id/statement/:fileId/file')
  @Header('Content-Type', 'application/pdf')
  async file(
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Ctx() ctx: TenantContext,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.statements.readFile({ ctx, reconciliationId: id, fileId });

    response.setHeader(
      'Content-Disposition',
      `inline; filename="${file.fileName.replace(/[^\w.\- ]/g, '_')}"`,
    );
    response.end(Buffer.from(file.content));
  }

  @Post(':id/matches')
  @HttpCode(200)
  async saveMatch(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ReconciliationWorkspaceResponse }> {
    const parsed = saveMatchRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return {
      data: await this.reconcile.saveMatch({ ctx, reconciliationId: id, ...parsed.data }),
    };
  }

  @Delete(':id/matches/:matchId')
  async removeMatch(
    @Param('id') id: string,
    @Param('matchId') matchId: string,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ReconciliationWorkspaceResponse }> {
    return { data: await this.reconcile.removeMatch({ ctx, reconciliationId: id, matchId }) };
  }

  @Post(':id/complete')
  @HttpCode(200)
  async complete(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ReconciliationWorkspaceResponse }> {
    const parsed = completeReconciliationRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return {
      data: await this.reconcile.complete({
        ctx,
        reconciliationId: id,
        statementClosingBalanceMinor: parsed.data.statementClosingBalanceMinor,
        note: parsed.data.note,
        expectedVersion: parsed.data.version,
      }),
    };
  }

  @Post(':id/reopen')
  @HttpCode(200)
  async reopen(
    @Param('id') id: string,
    @Body() body: unknown,
    @Ctx() ctx: TenantContext,
  ): Promise<{ data: ReconciliationWorkspaceResponse }> {
    const parsed = reopenReconciliationRequestSchema.safeParse(body);
    if (!parsed.success) throw invalidBody(parsed.error.issues);

    return {
      data: await this.reconcile.reopen({
        ctx,
        reconciliationId: id,
        reason: parsed.data.reason,
        expectedVersion: parsed.data.version,
      }),
    };
  }
}
