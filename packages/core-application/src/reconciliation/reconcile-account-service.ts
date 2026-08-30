import { matchStatement } from '@sher/core-domain';
import type { MatchableRow, MatchOutcome, MatchPair } from '@sher/core-domain';
import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  MatchStateValue,
  ReconciliationLedgerRow,
  ReconciliationListResponse,
  ReconciliationStatementRow,
  ReconciliationStatusValue,
  ReconciliationSummary,
  ReconciliationWorkspaceResponse,
} from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import type {
  LedgerLineRow,
  MatchRecord,
  NewMatch,
  ReconcilableAccount,
  ReconciliationRepository,
  ReconciliationRow,
  StatementLineRecord,
} from './reconciliation-repository';

/**
 * Reconciling a bank or MFS account against the statement the bank produced
 * (§5.17, UI-70, D-43, Phase 11).
 *
 * **This service cannot post anything, and that is deliberate structure rather
 * than discipline.** Look at what it is given: a unit of work, permissions, an
 * audit writer, a clock and a repository whose only writes are statement files,
 * statement lines, reconciliations and matches. There is no expense service, no
 * receipt service, no payment service, no correction or reversal helper, no
 * numbering service and no period guard — because it never posts, never
 * corrects, never re-dates and never cancels. When the owner needs any of those,
 * the screen opens the owning module's own dialog and that module does its own
 * work, with its own permission, its own period rules and its own audit event.
 * A later attempt to post from here does not pass review; it does not compile.
 *
 * **Automatic matches are computed, not stored — until the sign-off.** The
 * engine is deterministic, so recomputing on every read is both cheaper and
 * more honest than a cached link: correct a transaction and the next read of
 * the screen already reflects it, with no invalidation to forget. Only human
 * decisions are written while a reconciliation is open. Completing it freezes
 * every link that was standing, because from that moment the reconciliation is
 * historical control data and must keep saying what it said.
 */

export interface StartReconciliationCommand {
  readonly ctx: TenantContext;
  readonly accountId: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly operationId: string;
}

export interface WorkspaceCommand {
  readonly ctx: TenantContext;
  readonly reconciliationId: string;
}

export interface SaveMatchCommand extends WorkspaceCommand {
  readonly statementLineId: string | null;
  readonly journalLineId: string | null;
  readonly state: MatchStateValue;
}

export interface RemoveMatchCommand extends WorkspaceCommand {
  readonly matchId: string;
}

export interface CompleteReconciliationCommand extends WorkspaceCommand {
  readonly statementClosingBalanceMinor: number;
  readonly note: string | null;
  readonly expectedVersion: number;
}

export interface ReopenReconciliationCommand extends WorkspaceCommand {
  readonly reason: string;
  readonly expectedVersion: number;
}

export interface ListReconciliationsCommand {
  readonly ctx: TenantContext;
  readonly accountId: string | null;
}

/** States a person sets. `AUTO` is the engine's and is never accepted here. */
const HUMAN_STATES: readonly MatchStateValue[] = [
  'CONFIRMED',
  'MANUAL',
  'REJECTED',
  'NEEDS_REVIEW',
  'OUTSTANDING',
];

/** The states that mean "this row of ours is on the statement". */
const LINKED_STATES: readonly MatchStateValue[] = ['AUTO', 'CONFIRMED', 'MANUAL'];

export class ReconcileAccountService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly reconciliations: ReconciliationRepository,
    private readonly idempotency: IdempotencyStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /* -------------------------------------------------------------- starting */

  async start(command: StartReconciliationCommand): Promise<ReconciliationWorkspaceResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.RECONCILIATION_PERFORM);

      const replay = await this.idempotency.find(tx, ctx, command.operationId);
      if (replay !== null) return replay.response as ReconciliationWorkspaceResponse;

      if (command.fromDate > command.toDate) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'The last day cannot be before the first');
      }

      const account = await this.requireAccount(tx, ctx, command.accountId);

      // §5.16.8 and UI-71: cash is reconciled by counting the drawer, against
      // what the day expected. A bank statement workflow over a cash box would
      // be a second, contradictory answer to the same question.
      if (account.type === 'CASH') {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Cash is reconciled in Daily Cash, by counting the drawer against what the day expected',
        );
      }

      const openDraft = await this.reconciliations.findDraftForAccount(tx, ctx, account.id);
      if (openDraft !== null) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'This account already has a reconciliation in progress — finish or reopen that one',
          { reconciliationId: openDraft.id },
        );
      }

      const id = Ulid.generate(this.clock);
      await this.reconciliations.insert(tx, ctx, {
        id,
        accountId: account.id,
        fromDate: command.fromDate,
        toDate: command.toDate,
        operationId: command.operationId,
      });

      await this.audit.append(tx, ctx, {
        entityType: 'ACCOUNT_RECONCILIATION',
        entityId: id,
        action: 'STARTED',
        before: null,
        after: {
          accountId: account.id,
          fromDate: command.fromDate,
          toDate: command.toDate,
        },
        source: 'API',
      });

      const workspace = await this.build(tx, ctx, id);
      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: JSON.stringify({
          accountId: command.accountId,
          fromDate: command.fromDate,
          toDate: command.toDate,
        }),
        response: workspace,
      });

      return workspace;
    });
  }

  /* --------------------------------------------------------------- reading */

  async workspace(command: WorkspaceCommand): Promise<ReconciliationWorkspaceResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.RECONCILIATION_VIEW);
      return this.build(tx, ctx, command.reconciliationId);
    });
  }

  async list(command: ListReconciliationsCommand): Promise<ReconciliationListResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.RECONCILIATION_VIEW);

      const rows = await this.reconciliations.list(tx, ctx, { accountId: command.accountId });

      return {
        rows: rows.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          accountName: row.accountName,
          fromDate: row.fromDate,
          toDate: row.toDate,
          status: row.status,
          differenceMinor: row.differenceMinor,
          completedAt: row.completedAt,
        })),
      };
    });
  }

  /* -------------------------------------------------------------- matching */

  /**
   * Confirm a suggestion, link two rows by hand, reject a suggestion, park a
   * row for review, or say one of ours has simply not cleared yet.
   *
   * Every one of those is a statement about a **link**. None of them changes a
   * transaction, and the rows named must both belong to this reconciliation —
   * a match request naming somebody else's journal line is refused rather than
   * quietly ignored.
   */
  async saveMatch(command: SaveMatchCommand): Promise<ReconciliationWorkspaceResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.RECONCILIATION_PERFORM);

      const reconciliation = await this.requireDraft(tx, ctx, command.reconciliationId);
      if (!HUMAN_STATES.includes(command.state)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'That is not a decision a person makes');
      }

      const needsBothSides = command.state === 'CONFIRMED' || command.state === 'MANUAL';
      if (needsBothSides && (command.statementLineId === null || command.journalLineId === null)) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'A match needs a row from each side');
      }
      if (command.state === 'OUTSTANDING' && command.journalLineId === null) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Only one of our own entries can be marked as not yet cleared',
        );
      }

      const [ledger, statementLines] = await Promise.all([
        this.reconciliations.listLedger(tx, ctx, {
          accountCode: reconciliation.accountCode,
          fromDate: reconciliation.fromDate,
          toDate: reconciliation.toDate,
        }),
        this.reconciliations.listLines(tx, ctx, reconciliation.id),
      ]);

      const ours =
        command.journalLineId === null
          ? null
          : (ledger.find((row) => row.journalLineId === command.journalLineId) ?? null);
      if (command.journalLineId !== null && ours === null) {
        throw new AppError(ErrorCode.NOT_FOUND, 'That entry is not in this reconciliation');
      }
      if (
        command.statementLineId !== null &&
        !statementLines.some((line) => line.id === command.statementLineId)
      ) {
        throw new AppError(ErrorCode.NOT_FOUND, 'That statement line is not in this reconciliation');
      }

      await this.reconciliations.insertMatches(tx, ctx, [
        {
          id: Ulid.generate(this.clock),
          reconciliationId: reconciliation.id,
          statementLineId: command.statementLineId,
          journalLineId: command.journalLineId,
          state: command.state,
          score: null,
          reasons: [],
          documentType: ours?.sourceType ?? null,
          documentId: ours?.sourceDocumentId ?? null,
          documentVersion: ours?.postingCount ?? null,
        },
      ]);

      await this.audit.append(tx, ctx, {
        entityType: 'ACCOUNT_RECONCILIATION',
        entityId: reconciliation.id,
        action: `MATCH_${command.state}`,
        before: null,
        after: {
          statementLineId: command.statementLineId,
          journalLineId: command.journalLineId,
        },
        source: 'API',
      });

      return this.build(tx, ctx, reconciliation.id);
    });
  }

  async removeMatch(command: RemoveMatchCommand): Promise<ReconciliationWorkspaceResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.RECONCILIATION_PERFORM);

      const reconciliation = await this.requireDraft(tx, ctx, command.reconciliationId);
      const removed = await this.reconciliations.deleteMatch(tx, ctx, command.matchId);
      if (!removed) throw new AppError(ErrorCode.NOT_FOUND, 'That link is already gone');

      await this.audit.append(tx, ctx, {
        entityType: 'ACCOUNT_RECONCILIATION',
        entityId: reconciliation.id,
        action: 'MATCH_REMOVED',
        before: { matchId: command.matchId },
        after: null,
        source: 'API',
      });

      return this.build(tx, ctx, reconciliation.id);
    });
  }

  /* ------------------------------------------------------------- finishing */

  /**
   * Sign the reconciliation off.
   *
   * Refused unless everything is resolved: the difference is zero, no pair is
   * in conflict, nothing is parked for review, every statement line has been
   * accounted for and every one of our own entries is either matched or
   * explicitly marked as not yet cleared. A reconciliation completed with a
   * loose end is worse than one left open, because it says the account agreed
   * when it did not.
   */
  async complete(
    command: CompleteReconciliationCommand,
  ): Promise<ReconciliationWorkspaceResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.RECONCILIATION_PERFORM);

      const reconciliation = await this.requireDraft(tx, ctx, command.reconciliationId);
      const workspace = await this.build(tx, ctx, reconciliation.id, {
        statementClosingMinor: command.statementClosingBalanceMinor,
      });

      if (workspace.summary.blockers.length > 0) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'This reconciliation is not finished yet',
          { blockers: workspace.summary.blockers.join(' · ') },
        );
      }

      // Freeze what was signed off. Until now the engine's links were computed
      // on every read; from here they are the record, with the posting count of
      // each document as it stood — which is what later turns a corrected
      // transaction into REVIEW_REQUIRED (R-22).
      const frozen = await this.freezeAutoLinks(tx, ctx, reconciliation);
      if (frozen.length > 0) await this.reconciliations.insertMatches(tx, ctx, frozen);

      const ok = await this.reconciliations.complete(tx, ctx, {
        id: reconciliation.id,
        expectedVersion: command.expectedVersion,
        statementOpeningMinor: workspace.summary.statementOpeningMinor,
        statementClosingMinor: command.statementClosingBalanceMinor,
        bookOpeningMinor: workspace.summary.bookOpeningMinor,
        reconciledBalanceMinor: workspace.summary.reconciledBalanceMinor,
        differenceMinor: workspace.summary.differenceMinor,
        note: command.note,
      });
      if (!ok) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this reconciliation — reload and try again',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'ACCOUNT_RECONCILIATION',
        entityId: reconciliation.id,
        action: 'COMPLETED',
        before: { status: 'DRAFT' },
        after: {
          status: 'COMPLETED',
          statementClosingMinor: command.statementClosingBalanceMinor,
          reconciledBalanceMinor: workspace.summary.reconciledBalanceMinor,
          differenceMinor: workspace.summary.differenceMinor,
        },
        source: 'API',
      });

      return this.build(tx, ctx, reconciliation.id);
    });
  }

  /**
   * Reopen a completed reconciliation — the only way back, and its own
   * permission.
   *
   * What was signed off is **not** erased: the links stay exactly as they were,
   * the reason is recorded, and the audit trail keeps both facts. Reopening
   * says the shop is looking again, not that the earlier sign-off never
   * happened.
   */
  async reopen(command: ReopenReconciliationCommand): Promise<ReconciliationWorkspaceResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, Permission.RECONCILIATION_REOPEN);

      const reconciliation = await this.requireExisting(tx, ctx, command.reconciliationId);
      if (reconciliation.status === 'DRAFT') {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'This reconciliation is already open');
      }

      const ok = await this.reconciliations.reopen(tx, ctx, {
        id: reconciliation.id,
        expectedVersion: command.expectedVersion,
        reason: command.reason,
      });
      if (!ok) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this reconciliation — reload and try again',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: 'ACCOUNT_RECONCILIATION',
        entityId: reconciliation.id,
        action: 'REOPENED',
        before: { status: reconciliation.status },
        after: { status: 'DRAFT' },
        reason: command.reason,
        source: 'API',
      });

      return this.build(tx, ctx, reconciliation.id);
    });
  }

  /* --------------------------------------------------------------- reading */

  private async requireExisting(
    tx: Tx,
    ctx: TenantContext,
    id: string,
  ): Promise<ReconciliationRow> {
    const found = await this.reconciliations.findById(tx, ctx, id);
    if (found === null) throw new AppError(ErrorCode.NOT_FOUND, 'That reconciliation was not found');
    return found;
  }

  private async requireDraft(tx: Tx, ctx: TenantContext, id: string): Promise<ReconciliationRow> {
    const found = await this.requireExisting(tx, ctx, id);
    if (found.status !== 'DRAFT') {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'This reconciliation is signed off — reopen it before changing anything',
      );
    }
    return found;
  }

  private async requireAccount(
    tx: Tx,
    ctx: TenantContext,
    accountId: string,
  ): Promise<ReconcilableAccount> {
    const account = await this.reconciliations.findAccount(tx, ctx, accountId);
    if (account === null) throw new AppError(ErrorCode.NOT_FOUND, 'That account no longer exists');
    return account;
  }

  /** The links the engine would make now, ready to be written at sign-off. */
  private async freezeAutoLinks(
    tx: Tx,
    ctx: TenantContext,
    reconciliation: ReconciliationRow,
  ): Promise<readonly NewMatch[]> {
    const [ledger, lines, matches] = await Promise.all([
      this.reconciliations.listLedger(tx, ctx, {
        accountCode: reconciliation.accountCode,
        fromDate: reconciliation.fromDate,
        toDate: reconciliation.toDate,
      }),
      this.reconciliations.listLines(tx, ctx, reconciliation.id),
      this.reconciliations.listMatches(tx, ctx, reconciliation.id),
    ]);

    const outcome = runEngine(ledger, lines, matches);
    const byLine = new Map(ledger.map((row) => [row.journalLineId, row]));

    return outcome.auto.map((pair) => {
      const ours = byLine.get(pair.ledgerId);
      return {
        id: Ulid.generate(this.clock),
        reconciliationId: reconciliation.id,
        statementLineId: pair.statementLineId,
        journalLineId: pair.ledgerId,
        state: 'AUTO' as const,
        score: pair.score,
        reasons: pair.reasons,
        documentType: ours?.sourceType ?? null,
        documentId: ours?.sourceDocumentId ?? null,
        documentVersion: ours?.postingCount ?? null,
      };
    });
  }

  /**
   * The whole screen, from the ledger and the four reconciliation tables.
   *
   * Read-only: it never writes, not even to cache a match, so opening a
   * reconciliation changes nothing and two people looking at once see the same
   * thing.
   */
  private async build(
    tx: Tx,
    ctx: TenantContext,
    id: string,
    provisional?: { readonly statementClosingMinor: number },
  ): Promise<ReconciliationWorkspaceResponse> {
    const reconciliation = await this.requireExisting(tx, ctx, id);

    const [ledger, lines, matches, files, bookOpeningMinor] = await Promise.all([
      this.reconciliations.listLedger(tx, ctx, {
        accountCode: reconciliation.accountCode,
        fromDate: reconciliation.fromDate,
        toDate: reconciliation.toDate,
      }),
      this.reconciliations.listLines(tx, ctx, reconciliation.id),
      this.reconciliations.listMatches(tx, ctx, reconciliation.id),
      this.reconciliations.listFiles(tx, ctx, reconciliation.id),
      this.reconciliations.sumBefore(
        tx,
        ctx,
        reconciliation.accountCode,
        reconciliation.fromDate,
      ),
    ]);

    const completed = reconciliation.status !== 'DRAFT';
    // A signed-off reconciliation shows what it certified. A live one shows
    // what the engine makes of the ledger as it stands right now, which is why
    // a correction posted a moment ago is already reflected here.
    const outcome = completed
      ? { auto: [], suggested: [], conflicts: [] }
      : runEngine(ledger, lines, matches);

    const statementLink = new Map<string, { matchId: string | null; state: MatchStateValue; journalLineId: string | null }>();
    const ledgerLink = new Map<string, { matchId: string | null; state: MatchStateValue; statementLineId: string | null }>();

    for (const match of matches) {
      if (match.state === 'REJECTED') continue;
      if (match.statementLineId !== null) {
        statementLink.set(match.statementLineId, {
          matchId: match.id,
          state: match.state,
          journalLineId: match.journalLineId,
        });
      }
      if (match.journalLineId !== null) {
        ledgerLink.set(match.journalLineId, {
          matchId: match.id,
          state: match.state,
          statementLineId: match.statementLineId,
        });
      }
    }
    for (const pair of outcome.auto) {
      statementLink.set(pair.statementLineId, {
        matchId: null,
        state: 'AUTO',
        journalLineId: pair.ledgerId,
      });
      ledgerLink.set(pair.ledgerId, {
        matchId: null,
        state: 'AUTO',
        statementLineId: pair.statementLineId,
      });
    }

    const ledgerRows: ReconciliationLedgerRow[] = ledger.map((row) => {
      const link = ledgerLink.get(row.journalLineId) ?? null;
      return {
        journalLineId: row.journalLineId,
        businessDate: row.businessDate,
        createdAt: row.createdAt,
        sourceType: row.sourceType,
        sourceNumber: row.sourceNumber,
        documentType: row.sourceType,
        documentId: row.sourceDocumentId,
        documentVersion: row.postingCount,
        description: describeLedger(row),
        reference: row.sourceNumber,
        amountMinor: row.amountMinor,
        matchId: link?.matchId ?? null,
        matchState: link?.state ?? null,
        statementLineId: link?.statementLineId ?? null,
      };
    });

    const unmatchedStatementAmounts = lines
      .filter((line) => !statementLink.has(line.id))
      .map((line) => line.amountMinor);

    const foreign =
      unmatchedStatementAmounts.length === 0
        ? []
        : await this.reconciliations.findOnOtherAccounts(tx, ctx, {
            excludeAccountCode: reconciliation.accountCode,
            amountsMinor: [...new Set(unmatchedStatementAmounts)],
            fromDate: reconciliation.fromDate,
            toDate: reconciliation.toDate,
          });

    const statementRows: ReconciliationStatementRow[] = lines.map((line) => {
      const link = statementLink.get(line.id) ?? null;
      const elsewhere =
        link === null ? (foreign.find((row) => row.amountMinor === line.amountMinor) ?? null) : null;

      return {
        statementLineId: line.id,
        lineNo: line.lineNo,
        businessDate: line.businessDate,
        description: line.description,
        reference: line.reference,
        amountMinor: line.amountMinor,
        balanceMinor: line.balanceMinor,
        editedByUser: line.editedByUser,
        matchId: link?.matchId ?? null,
        matchState: link?.state ?? null,
        journalLineId: link?.journalLineId ?? null,
        possibleWrongAccount:
          elsewhere === null
            ? null
            : {
                accountId: elsewhere.accountId,
                accountName: elsewhere.accountName,
                sourceNumber: elsewhere.sourceNumber,
              },
      };
    });

    // R-22: a document corrected, cancelled or re-dated after the sign-off has
    // posted again, so its posting count no longer matches the snapshot taken
    // when it was matched. Nothing wrote into this reconciliation to say so —
    // it is read back from the ledger, which is the only way a completed
    // reconciliation can stay untouched and still tell the truth.
    const changedSinceCompletion = completed
      ? matches
          .filter((match) => match.journalLineId !== null && match.documentVersion !== null)
          .flatMap((match) => {
            const current = ledger.find((row) => row.journalLineId === match.journalLineId);
            if (current === undefined || current.postingCount === match.documentVersion) return [];
            return [
              {
                journalLineId: current.journalLineId,
                sourceNumber: current.sourceNumber,
                sourceType: current.sourceType,
              },
            ];
          })
      : [];

    const summary = summarize({
      reconciliation,
      ledgerRows,
      statementRows,
      matches,
      outcome,
      bookOpeningMinor,
      files,
      provisionalClosingMinor: provisional?.statementClosingMinor ?? null,
    });

    const status: ReconciliationStatusValue =
      changedSinceCompletion.length > 0 ? 'REVIEW_REQUIRED' : reconciliation.status;

    return {
      id: reconciliation.id,
      accountId: reconciliation.accountId,
      accountName: reconciliation.accountName,
      accountType: reconciliation.accountType,
      fromDate: reconciliation.fromDate,
      toDate: reconciliation.toDate,
      status,
      note: reconciliation.note,
      completedAt: reconciliation.completedAt,
      completedByName: reconciliation.completedByName,
      version: reconciliation.version,
      files: files.map((file) => ({
        fileId: file.id,
        fileName: file.fileName,
        parseStatus: file.parseStatus,
        byteSize: file.byteSize,
        importedAt: file.importedAt,
        uploadedAt: file.createdAt,
      })),
      ledgerRows,
      statementRows,
      suggestions: outcome.suggested.map((pair) => ({
        journalLineId: pair.ledgerId,
        statementLineId: pair.statementLineId,
        score: pair.score,
        reasons: [...pair.reasons],
      })),
      conflicts: outcome.conflicts.map((conflict) => ({
        journalLineId: conflict.ledgerId,
        statementLineId: conflict.statementLineId,
        reference: conflict.reference,
        ledgerAmountMinor: conflict.ledgerAmountMinor,
        statementAmountMinor: conflict.statementAmountMinor,
      })),
      summary,
      changedSinceCompletion,
    };
  }
}

/* --------------------------------------------------------------- the engine */

/**
 * Runs the matching engine over what has not already been decided by a person.
 *
 * Rows a person has already matched, parked, or marked as uncleared are taken
 * off the table first, and rejected pairs are excluded by pair rather than by
 * row — saying "these two are not the same" must not stop either of them
 * matching something else.
 */
function runEngine(
  ledger: readonly LedgerLineRow[],
  lines: readonly StatementLineRecord[],
  matches: readonly MatchRecord[],
): MatchOutcome {
  const decidedLedger = new Set(
    matches.filter((m) => m.state !== 'REJECTED' && m.journalLineId !== null).map((m) => m.journalLineId),
  );
  const decidedStatement = new Set(
    matches.filter((m) => m.state !== 'REJECTED' && m.statementLineId !== null).map((m) => m.statementLineId),
  );
  const rejected = new Set(
    matches
      .filter((m) => m.state === 'REJECTED')
      .map((m) => `${m.journalLineId ?? ''}|${m.statementLineId ?? ''}`),
  );

  const ourRows: MatchableRow[] = ledger
    .filter((row) => !decidedLedger.has(row.journalLineId))
    .map((row) => ({
      id: row.journalLineId,
      businessDate: row.businessDate,
      amountMinor: row.amountMinor,
      reference: row.sourceNumber,
      description: describeLedger(row),
    }));

  const theirRows: MatchableRow[] = lines
    .filter((line) => !decidedStatement.has(line.id))
    .map((line) => ({
      id: line.id,
      businessDate: line.businessDate,
      amountMinor: line.amountMinor,
      reference: line.reference,
      description: line.description,
    }));

  const outcome = matchStatement(ourRows, theirRows);
  const keep = (pair: MatchPair): boolean => !rejected.has(`${pair.ledgerId}|${pair.statementLineId}`);

  return {
    auto: outcome.auto.filter(keep),
    suggested: outcome.suggested.filter(keep),
    conflicts: outcome.conflicts.filter(
      (conflict) => !rejected.has(`${conflict.ledgerId}|${conflict.statementLineId}`),
    ),
  };
}

/** What a journal line says about itself, in words the matcher can compare. */
function describeLedger(row: LedgerLineRow): string {
  return `${row.sourceType.replace(/_/g, ' ').toLowerCase()} ${row.sourceNumber}`.trim();
}

/* -------------------------------------------------------------- the summary */

interface SummaryInput {
  readonly reconciliation: ReconciliationRow;
  readonly ledgerRows: readonly ReconciliationLedgerRow[];
  readonly statementRows: readonly ReconciliationStatementRow[];
  readonly matches: readonly MatchRecord[];
  readonly outcome: MatchOutcome;
  readonly bookOpeningMinor: number;
  readonly files: readonly { readonly parsedOpeningMinor: number | null; readonly parsedClosingMinor: number | null; readonly importedAt: string | null }[];
  readonly provisionalClosingMinor: number | null;
}

/**
 * The figures at the top of the screen, and what still stands in the way.
 *
 * **Reconciled balance** is the opening balance plus every one of our entries
 * the statement also shows. Entries the bank has not cleared yet are excluded
 * on purpose — that is what makes the comparison meaningful: `opening +
 * cleared` is precisely what the bank should be reporting as its closing
 * balance, and any gap is a real difference rather than a timing artefact.
 */
function summarize(input: SummaryInput): ReconciliationSummary {
  const {
    reconciliation, ledgerRows, statementRows, matches, outcome, bookOpeningMinor,
  } = input;

  const linked = (state: MatchStateValue | null): boolean =>
    state !== null && LINKED_STATES.includes(state);

  const bookClosingMinor =
    bookOpeningMinor + ledgerRows.reduce((total, row) => total + row.amountMinor, 0);
  const reconciledBalanceMinor =
    bookOpeningMinor +
    ledgerRows.filter((row) => linked(row.matchState)).reduce((total, row) => total + row.amountMinor, 0);

  const importedFile = [...input.files].reverse().find((file) => file.importedAt !== null) ?? null;
  const statementOpeningMinor =
    reconciliation.statementOpeningMinor ?? importedFile?.parsedOpeningMinor ?? null;
  const statementClosingMinor =
    input.provisionalClosingMinor ??
    reconciliation.statementClosingMinor ??
    importedFile?.parsedClosingMinor ??
    null;

  const differenceMinor =
    statementClosingMinor === null ? 0 : statementClosingMinor - reconciledBalanceMinor;

  const autoMatched = ledgerRows.filter((row) => row.matchState === 'AUTO').length;
  const manualMatched = ledgerRows.filter(
    (row) => row.matchState === 'CONFIRMED' || row.matchState === 'MANUAL',
  ).length;
  const outstanding = ledgerRows.filter((row) => row.matchState === 'OUTSTANDING').length;
  const needsReview =
    matches.filter((match) => match.state === 'NEEDS_REVIEW').length;
  const statementOnly = statementRows.filter((row) => row.matchState === null).length;
  const ledgerOnly = ledgerRows.filter((row) => row.matchState === null).length;

  const blockers: string[] = [];
  if (statementClosingMinor === null) {
    blockers.push('Confirm the closing balance the statement shows');
  } else if (differenceMinor !== 0) {
    blockers.push('The statement and the matched entries do not agree yet');
  }
  if (outcome.conflicts.length > 0) {
    blockers.push('Some rows share a reference but not an amount');
  }
  if (needsReview > 0) blockers.push('Some rows are still marked for review');
  if (statementOnly > 0) {
    blockers.push('The statement has entries the shop has not recorded yet');
  }
  if (ledgerOnly > 0) {
    blockers.push('Some of our entries are neither matched nor marked as not yet cleared');
  }

  return {
    statementOpeningMinor,
    statementClosingMinor,
    bookOpeningMinor,
    bookClosingMinor,
    reconciledBalanceMinor,
    differenceMinor,
    autoMatched,
    manualMatched,
    suggested: outcome.suggested.length,
    statementOnly,
    ledgerOnly,
    outstanding,
    conflicts: outcome.conflicts.length,
    needsReview,
    blockers,
  };
}
