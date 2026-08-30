import { parseStatement } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  StatementLineDraft,
  StatementPreviewResponse,
  ReconciliationWorkspaceResponse,
} from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { ReconcileAccountService } from './reconcile-account-service';
import type { ReconciliationRepository, StatementLineRecord } from './reconciliation-repository';
import type { StatementExtractor } from './statement-extractor';

/**
 * Reading a bank or MFS statement into a reconciliation (§5.17, Phase 11).
 *
 * Three steps, and the middle one is a person: the file is stored and parsed,
 * the owner reads the rows and repairs anything the parser got wrong, and only
 * then are the rows imported. What gets reconciled is what they approved — a
 * parser confident enough to skip that step is a parser nobody can check.
 *
 * **The file is kept whether or not it could be read.** A scanned statement
 * parses to nothing and is stored anyway, because the owner still has the paper
 * and can reconcile against it by hand; the evidence is the PDF, and the parsed
 * rows are working data (§5.17).
 *
 * Like everything in this module, it posts nothing. It writes a file, its lines,
 * and no third thing.
 */

export interface UploadStatementCommand {
  readonly ctx: TenantContext;
  readonly reconciliationId: string;
  readonly fileName: string;
  readonly content: Uint8Array;
}

export interface ConfirmStatementCommand {
  readonly ctx: TenantContext;
  readonly reconciliationId: string;
  readonly fileId: string;
  readonly lines: readonly StatementLineDraft[];
}

export interface ReadStatementFileCommand {
  readonly ctx: TenantContext;
  readonly reconciliationId: string;
  readonly fileId: string;
}

export interface StatementFileContent {
  readonly fileName: string;
  readonly content: Uint8Array;
}

export class ImportStatementService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly reconciliations: ReconciliationRepository,
    private readonly extractor: StatementExtractor,
    private readonly workspaces: ReconcileAccountService,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /** Store the PDF, read what can be read, and show the owner the result. */
  async upload(command: UploadStatementCommand): Promise<StatementPreviewResponse> {
    const { ctx } = command;

    // Extraction happens outside the transaction: it is CPU work on bytes the
    // caller already holds, and holding a database transaction open through it
    // would block the row for as long as the PDF takes.
    const extracted = await this.extract(command.content);
    const parsed = parseStatement(extracted);

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.RECONCILIATION_PERFORM);

      const reconciliation = await this.reconciliations.findById(tx, ctx, command.reconciliationId);
      if (reconciliation === null) {
        throw new AppError(ErrorCode.NOT_FOUND, 'That reconciliation was not found');
      }
      if (reconciliation.status !== 'DRAFT') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'This reconciliation is signed off — reopen it before adding a statement',
        );
      }

      const fileId = Ulid.generate(this.clock);
      await this.reconciliations.insertFile(tx, ctx, {
        id: fileId,
        accountId: reconciliation.accountId,
        reconciliationId: reconciliation.id,
        fileName: command.fileName,
        content: command.content,
        parseStatus: parsed.status,
        parsedFromDate: parsed.fromDate,
        parsedToDate: parsed.toDate,
        parsedOpeningMinor: parsed.openingBalanceMinor,
        parsedClosingMinor: parsed.closingBalanceMinor,
        problems: parsed.problems,
      });

      await this.audit.append(tx, ctx, {
        entityType: 'BANK_STATEMENT_FILE',
        entityId: fileId,
        action: 'UPLOADED',
        before: null,
        after: {
          reconciliationId: reconciliation.id,
          fileName: command.fileName,
          parseStatus: parsed.status,
          lines: parsed.lines.length,
        },
        source: 'API',
      });

      return {
        fileId,
        fileName: command.fileName,
        parseStatus: parsed.status,
        fromDate: parsed.fromDate,
        toDate: parsed.toDate,
        openingBalanceMinor: parsed.openingBalanceMinor,
        closingBalanceMinor: parsed.closingBalanceMinor,
        lines: parsed.lines.map((line) => ({
          lineNo: line.lineNo,
          businessDate: line.businessDate,
          description: line.description,
          reference: line.reference,
          amountMinor: line.amountMinor,
          balanceMinor: line.balanceMinor,
          editedByUser: false,
        })),
        problems: parsed.problems.map((problem) => ({
          lineNo: problem.lineNo,
          text: problem.text,
          reason: problem.reason,
        })),
      };
    });
  }

  /**
   * Import the rows the owner approved.
   *
   * Replaces whatever this file imported before, so re-importing a statement
   * the owner has corrected does not leave the first reading behind. Human
   * decisions about *other* rows are untouched — they hang off statement lines,
   * and re-importing the same file replaces its lines with new ids, which is
   * why this is refused once any matching has been done against them.
   */
  async confirm(command: ConfirmStatementCommand): Promise<ReconciliationWorkspaceResponse> {
    const { ctx } = command;

    await this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.RECONCILIATION_PERFORM);

      const reconciliation = await this.reconciliations.findById(tx, ctx, command.reconciliationId);
      if (reconciliation === null) {
        throw new AppError(ErrorCode.NOT_FOUND, 'That reconciliation was not found');
      }
      if (reconciliation.status !== 'DRAFT') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'This reconciliation is signed off — reopen it before adding a statement',
        );
      }

      const file = await this.reconciliations.findFile(tx, ctx, command.fileId);
      if (file === null || file.reconciliationId !== reconciliation.id) {
        throw new AppError(ErrorCode.NOT_FOUND, 'That statement file is not on this reconciliation');
      }

      const matches = await this.reconciliations.listMatches(tx, ctx, reconciliation.id);
      if (matches.length > 0) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Some rows have already been matched — remove those decisions before importing again',
        );
      }

      const lines: StatementLineRecord[] = command.lines.map((line) => ({
        id: Ulid.generate(this.clock),
        fileId: file.id,
        lineNo: line.lineNo,
        businessDate: line.businessDate,
        description: line.description,
        reference: line.reference,
        amountMinor: line.amountMinor,
        balanceMinor: line.balanceMinor,
        editedByUser: line.editedByUser,
      }));

      await this.reconciliations.replaceLines(tx, ctx, {
        reconciliationId: reconciliation.id,
        fileId: file.id,
        lines,
      });
      await this.reconciliations.markFileImported(tx, ctx, file.id);

      await this.audit.append(tx, ctx, {
        entityType: 'BANK_STATEMENT_FILE',
        entityId: file.id,
        action: 'IMPORTED',
        before: null,
        after: {
          reconciliationId: reconciliation.id,
          lines: lines.length,
          repaired: lines.filter((line) => line.editedByUser).length,
        },
        source: 'API',
      });
    });

    // Read back through the workspace so the caller sees the matching that the
    // new rows produced — the re-run the owner never has to ask for.
    return this.workspaces.workspace({
      ctx,
      reconciliationId: command.reconciliationId,
    });
  }

  /** `View Original Statement` — the bytes exactly as they were uploaded. */
  async readFile(command: ReadStatementFileCommand): Promise<StatementFileContent> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.RECONCILIATION_VIEW);

      const file = await this.reconciliations.findFile(tx, ctx, command.fileId);
      if (file === null || file.reconciliationId !== command.reconciliationId) {
        throw new AppError(ErrorCode.NOT_FOUND, 'That statement file was not found');
      }

      const content = await this.reconciliations.readFileContent(tx, ctx, command.fileId);
      if (content === null) throw new AppError(ErrorCode.NOT_FOUND, 'That statement file was not found');

      return { fileName: file.fileName, content };
    });
  }

  /**
   * A file the extractor cannot open at all — corrupt, encrypted, or not a PDF.
   *
   * Distinct from one it can open and find no text in: that is a scan, it is
   * stored, and the owner reconciles against the paper. This one has nothing to
   * store the owner could use, so it is refused with a message that says which
   * of the two happened.
   */
  private async extract(content: Uint8Array): ReturnType<StatementExtractor['extract']> {
    try {
      return await this.extractor.extract(content);
    } catch {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'This file could not be opened. If it is password-protected, save an unlocked copy and upload that.',
      );
    }
  }
}
