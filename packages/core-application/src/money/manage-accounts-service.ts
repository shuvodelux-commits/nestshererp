import {
  accountCodeFor,
  accountOpeningCorrectionPosting,
  accountOpeningPosting,
  canDeactivate,
  rejectMoneyAccount,
} from '@sher/core-domain';
import type { MoneyAccountRejection, MoneyAccountType } from '@sher/core-domain';
import { AppError, ErrorCode, Permission, SettingKey } from '@sher/core-contracts';
import type { MoneyAccountListResponse, MoneyAccountResponse } from '@sher/core-contracts';
import { Ulid } from '@sher/shared-utils';
import type { Clock } from '@sher/shared-utils';

import { entryModeFor } from '../notes/create-note-service';
import { requireLoanVisibility, seesLoans } from './loan-visibility';
import type { AccessControl } from '../ports/access-control';
import type { AuditWriter } from '../ports/audit-writer';
import type { IdempotencyStore } from '../ports/idempotency-store';
import type { NumberingService } from '../ports/numbering-service';
import type { PeriodGuard } from '../ports/period-guard';
import type { TenantContext } from '../ports/tenant-context';
import type { Tx, UnitOfWork } from '../ports/unit-of-work';
import { isFeatureOn, settingValuesOf } from '../settings/feature-dependencies';
import type { SettingsRepository } from '../settings/settings-repository';
import type { MoneyAccountRow, MoneyRepository } from './money-repository';

/**
 * Where the shop's money sits (Phase 4, §5.16, §5.17).
 *
 * **WRITE CLASS: M**, with a Class B passenger — the same shape
 * `ManagePartiesService` has, and for the same reason. The account is master
 * data; the balance it opens with is a posted document against
 * `OPENING_EQUITY`, because INV-07 makes an account's balance the sum of its
 * journal lines and a typed `balanceMinor` column would be false the moment it
 * was saved. That is why a period guard and a numbering service appear on a
 * path that is otherwise plain master data.
 *
 * **Three permissions, one table.** Cash and bank are separate trusts (§5.26):
 * a shop may let a manager see the till without letting them see the bank.
 * `MFS` follows bank — bKash is not something you can count at the counter.
 * `LOAN` follows neither: a loan is not one of the shop's money accounts but a
 * debt it carries, so it is admitted by `loan.account.manage` alone and never
 * appears for someone holding only the cash or the bank permission (owner
 * decision 2026-08-31).
 */

export interface ListAccountsCommand {
  readonly ctx: TenantContext;
  readonly includeInactive?: boolean | undefined;
  /** Balances at the end of this business date; absent means now. */
  readonly asOf?: string | undefined;
}

export interface AccountInput {
  readonly name: string;
  readonly type: MoneyAccountType;
  readonly holderName: string | null;
  readonly reference: string | null;
  readonly isDrawer: boolean;
  readonly openingAmountMinor: number;
  readonly openingDate: string | null;
}

export interface CreateAccountCommand {
  readonly ctx: TenantContext;
  readonly input: AccountInput;
  readonly operationId: string;
}

export interface UpdateAccountCommand {
  readonly ctx: TenantContext;
  readonly accountId: string;
  readonly input: AccountInput;
  readonly expectedVersion: number;
}

export interface DeactivateAccountCommand {
  readonly ctx: TenantContext;
  readonly accountId: string;
  readonly expectedVersion: number;
}

const ENTITY_TYPE = 'account';

const REJECTION_MESSAGES: Record<MoneyAccountRejection, string> = {
  ACCOUNT_NAME_REQUIRED: 'Give the account a name',
  ACCOUNT_NAME_TOO_LONG: 'That name is too long',
  ACCOUNT_REFERENCE_TOO_LONG: 'That account number is too long',
  ACCOUNT_TYPE_NOT_VALID: 'That is not an account type this shop can hold',
  ACCOUNT_DRAWER_MUST_BE_CASH: 'Only a cash account can be the drawer counted each day',
  ACCOUNT_OPENING_NOT_INTEGER_MINOR: 'The opening balance must be a whole amount',
  ACCOUNT_OPENING_NEGATIVE: 'The opening balance cannot be negative',
  ACCOUNT_OPENING_DATE_REQUIRED: 'Say which date this opening balance is as at',
};

/**
 * Which permission admits this kind of account — bank and MFS share one.
 *
 * Loans are **not** here: seeing one is satisfied by either loan code, which a
 * single-code `require` cannot express, so they go through
 * `requireLoanVisibility` instead.
 */
function viewPermissionFor(type: MoneyAccountType): string {
  if (type === 'CASH') return Permission.CASH_ACCOUNT_VIEW;
  return Permission.BANK_ACCOUNT_VIEW;
}

/** Setting an account up. A loan needs its own code, and only that one. */
function managePermissionFor(type: MoneyAccountType): string {
  if (type === 'CASH') return Permission.CASH_ACCOUNT_MANAGE;
  if (type === 'LOAN') return Permission.LOAN_ACCOUNT_MANAGE;
  return Permission.BANK_ACCOUNT_MANAGE;
}

export class ManageAccountsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly money: MoneyRepository,
    private readonly settings: SettingsRepository,
    private readonly numbering: NumberingService,
    private readonly periods: PeriodGuard,
    private readonly idempotency: IdempotencyStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /**
   * Every account the caller may see.
   *
   * Filtered by permission rather than refused: a cashier holding only
   * `cash.account.view` gets the till and the safe and simply does not learn
   * that a bank account exists, which is UI-09's "hide what you cannot do"
   * applied to data rather than to buttons.
   */
  async list(command: ListAccountsCommand): Promise<MoneyAccountListResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const held = await this.accessControl.permissionsOf(tx, ctx);
      const values = settingValuesOf(await this.settings.listStored(tx, ctx));
      const banksOn = isFeatureOn(values, SettingKey.BANK_ACCOUNTS_ENABLED);

      const types: MoneyAccountType[] = [];
      if (held.includes(Permission.CASH_ACCOUNT_VIEW)) types.push('CASH');
      if (banksOn && held.includes(Permission.BANK_ACCOUNT_VIEW)) types.push('BANK', 'MFS');
      /*
       * A loan is admitted by its own code and by nothing else, so a cashier
       * holding `cash.account.view` never learns what the shop owes, and a
       * bookkeeper holding `loan.account.manage` reaches the loans without
       * being given the till (owner decision 2026-08-31). Deliberately not
       * behind `bank_accounts_enabled`: a shop can carry a loan without
       * running a bank account through SherERP.
       */
      if (seesLoans(held)) types.push('LOAN');

      if (types.length === 0) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'You do not have permission to see the shop’s accounts',
        );
      }

      const accounts = await this.money.listAccounts(tx, ctx, {
        types,
        includeInactive: command.includeInactive ?? false,
        asOf: command.asOf ?? null,
      });

      return {
        accounts: accounts.map(toResponse),
        /*
         * One total per type. `totalBankMinor` used to mean "everything that is
         * not cash", which was the same thing while BANK and MFS were the only
         * other types — with loans on the list it would have added a debt into
         * the shop's bank balance and no screen could have taken it back out.
         */
        totalCashMinor: sumWhere(accounts, (row) => row.type === 'CASH'),
        totalBankMinor: sumWhere(accounts, (row) => row.type === 'BANK'),
        totalMfsMinor: sumWhere(accounts, (row) => row.type === 'MFS'),
        /*
         * Positive, because "owed" is how it is read and how it is displayed.
         * A loan's journal balance is a credit, so it is negative here, and a
         * tile showing ৳-75,000 would be asking a shopkeeper to translate a
         * sign convention (UI-21).
         */
        totalLoanMinor: -sumWhere(accounts, (row) => row.type === 'LOAN'),
      };
    });
  }

  async create(command: CreateAccountCommand): Promise<MoneyAccountResponse> {
    const { ctx, input } = command;
    const fingerprint = JSON.stringify(input);

    return this.uow.run(ctx, async (tx) => {
      await this.accessControl.require(tx, ctx, managePermissionFor(input.type));

      /*
       * R-D3: two cash boxes may legitimately be called different things and
       * hold the same amount, and nothing about a retried request would look
       * like a duplicate to the unique index on the name — a retry that timed
       * out after committing would create the account twice under two names
       * only if the client changed them, which it does not.
       */
      const replayed = await this.idempotency.find(tx, ctx, command.operationId);
      if (replayed !== null) {
        if (replayed.requestFingerprint !== fingerprint) {
          throw new AppError(
            ErrorCode.IDEMPOTENCY_KEY_REUSED,
            'This operation id was already used for a different account',
          );
        }
        return replayed.response as MoneyAccountResponse;
      }

      this.validate(input);
      await this.requireNoOtherDrawer(tx, ctx, input, null);

      const id = Ulid.generate(this.clock);
      await this.money.insertAccount(tx, ctx, {
        id,
        name: input.name.trim(),
        type: input.type,
        holderName: blankToNull(input.holderName),
        reference: blankToNull(input.reference),
        isDrawer: input.isDrawer,
      });

      if (input.openingAmountMinor > 0 && input.openingDate !== null) {
        await this.postOpening(tx, ctx, id, input.type, input.openingAmountMinor, input.openingDate);
      }

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: id,
        action: 'CREATE',
        before: null,
        after: {
          name: input.name.trim(),
          type: input.type,
          isDrawer: input.isDrawer ? 1 : 0,
          openingAmountMinor: String(input.openingAmountMinor),
        },
        source: 'API',
      });

      const response = toResponse(await this.requireAccount(tx, ctx, id));

      await this.idempotency.save(tx, ctx, {
        operationId: command.operationId,
        requestFingerprint: fingerprint,
        response,
      });

      return response;
    });
  }

  /**
   * Editing an account, opening balance included.
   *
   * A changed opening posts the §2.5 **delta** rather than rewriting the
   * original entry — so the statement shows what was first entered, that it was
   * corrected, and what it became. The alternative, editing the posted line,
   * would make a shop's own history depend on when you happened to look at it.
   */
  async update(command: UpdateAccountCommand): Promise<MoneyAccountResponse> {
    const { ctx, input } = command;

    return this.uow.run(ctx, async (tx) => {
      const existing = await this.requireAccount(tx, ctx, command.accountId);

      // Both sides: you may not move an account out of a kind you cannot
      // manage, nor into one you cannot.
      await this.accessControl.require(tx, ctx, managePermissionFor(existing.type));
      await this.accessControl.require(tx, ctx, managePermissionFor(input.type));

      this.validate(input);
      await this.requireNoOtherDrawer(tx, ctx, input, existing.id);

      const updated = await this.money.updateAccount(tx, ctx, {
        id: existing.id,
        name: input.name.trim(),
        type: input.type,
        holderName: blankToNull(input.holderName),
        reference: blankToNull(input.reference),
        isDrawer: input.isDrawer,
        status: existing.status,
        expectedVersion: command.expectedVersion,
      });
      if (!updated) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this account while you were editing it',
        );
      }

      await this.reconcileOpening(tx, ctx, existing, input);

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: existing.id,
        action: 'UPDATE',
        before: { name: existing.name, type: existing.type, isDrawer: existing.isDrawer ? 1 : 0 },
        after: { name: input.name.trim(), type: input.type, isDrawer: input.isDrawer ? 1 : 0 },
        source: 'API',
      });

      return toResponse(await this.requireAccount(tx, ctx, existing.id));
    });
  }

  /**
   * Taking an account out of use (owner decision 2026-08-24).
   *
   * Only at zero. The money has to be somewhere named first — the till, the
   * safe, the bank — because an inactive account still holding cash keeps that
   * cash in the shop's totals while nobody looks in the box. History never
   * blocks: this is a soft delete (§3.6) and the past stays readable.
   */
  async deactivate(command: DeactivateAccountCommand): Promise<MoneyAccountResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const existing = await this.requireAccount(tx, ctx, command.accountId);
      await this.accessControl.require(tx, ctx, managePermissionFor(existing.type));

      if (!canDeactivate(existing.balanceMinor)) {
        throw new AppError(
          ErrorCode.VALIDATION_FAILED,
          'Move the remaining money out of this account before taking it out of use',
        );
      }

      const updated = await this.money.updateAccount(tx, ctx, {
        id: existing.id,
        name: existing.name,
        type: existing.type,
        holderName: existing.holderName,
        reference: existing.reference,
        // A box nobody uses cannot be the box the day is counted against.
        isDrawer: false,
        status: 'INACTIVE',
        expectedVersion: command.expectedVersion,
      });
      if (!updated) {
        throw new AppError(
          ErrorCode.CONFLICT_STALE_VERSION,
          'Someone else changed this account while you were editing it',
        );
      }

      await this.audit.append(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: existing.id,
        action: 'DEACTIVATE',
        before: { status: existing.status },
        after: { status: 'INACTIVE' },
        source: 'API',
      });

      return toResponse(await this.requireAccount(tx, ctx, existing.id));
    });
  }

  /* ------------------------------------------------------------- internals */

  private validate(input: AccountInput): void {
    const rejection = rejectMoneyAccount({
      name: input.name,
      type: input.type,
      holderName: input.holderName,
      reference: input.reference,
      isDrawer: input.isDrawer,
      openingAmountMinor: input.openingAmountMinor,
      openingDate: input.openingDate,
    });
    if (rejection !== null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, REJECTION_MESSAGES[rejection]);
    }
  }

  /**
   * 0016's partial unique index would catch a second drawer, but catching it
   * here tells the shopkeeper which box currently holds the flag instead of
   * handing them a constraint violation.
   */
  private async requireNoOtherDrawer(
    tx: Tx,
    ctx: TenantContext,
    input: AccountInput,
    selfId: string | null,
  ): Promise<void> {
    if (!input.isDrawer) return;

    const drawer = await this.money.findDrawer(tx, ctx);
    if (drawer !== null && drawer.id !== selfId) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        `“${drawer.name}” is already the drawer counted each day`,
      );
    }
  }

  private async postOpening(
    tx: Tx,
    ctx: TenantContext,
    accountId: string,
    type: MoneyAccountType,
    amountMinor: number,
    businessDate: string,
  ): Promise<void> {
    const today = this.clock.businessDate(ctx.timezone);
    if (businessDate > today) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'An opening balance cannot be dated in the future',
      );
    }
    await this.periods.assertOpen(tx, ctx, businessDate);

    const account = accountCodeFor(type, accountId);
    // A loan's opening is what the shop already owes, so it is credited.
    const journal = accountOpeningPosting({ account, amountMinor, owed: type === 'LOAN' });
    const openingId = Ulid.generate(this.clock);
    const number = await this.numbering.allocate(
      tx,
      ctx,
      'ACCOUNT_OPENING',
      Number(businessDate.slice(0, 4)),
    );

    await this.money.insertAccountOpening(tx, ctx, {
      id: openingId,
      number,
      accountId,
      amountMinor,
      businessDate,
      entryMode: entryModeFor(businessDate, today),
      operationId: openingId,
      journal: {
        journalEntryId: Ulid.generate(this.clock),
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        sourceType: 'ACCOUNT_OPENING',
        sourceId: openingId,
        sourceNumber: number,
        lines: journal.lines.map((line) => ({
          id: Ulid.generate(this.clock),
          account: line.account,
          amountMinor: line.amountMinor,
          partyId: line.partyId,
        })),
      },
    });

    await this.audit.append(tx, ctx, {
      entityType: 'account_opening',
      entityId: openingId,
      action: 'CREATE',
      before: null,
      after: { accountId, amountMinor: String(amountMinor), businessDate },
      source: 'API',
    });
  }

  /** Posts whatever the edit did to the opening: added it, or corrected it. */
  private async reconcileOpening(
    tx: Tx,
    ctx: TenantContext,
    existing: MoneyAccountRow,
    input: AccountInput,
  ): Promise<void> {
    const had = existing.openingAmountMinor ?? 0;
    const wants = input.openingAmountMinor;

    if (had === wants) return;

    if (existing.openingId === null || existing.openingVersion === null) {
      if (wants > 0 && input.openingDate !== null) {
        await this.postOpening(tx, ctx, existing.id, input.type, wants, input.openingDate);
      }
      return;
    }

    /*
     * Correcting to zero is refused rather than treated as a delete. §2.5 has
     * no "unpost" — a posted opening that should never have existed is
     * corrected towards the right figure, and a shop that genuinely opened with
     * nothing did not need an opening in the first place.
     */
    if (wants === 0) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'An opening balance that is already posted cannot be removed — correct it to the right amount instead',
      );
    }

    const businessDate = input.openingDate ?? existing.openingDate;
    if (businessDate === null) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Say which date this opening balance is as at');
    }
    await this.periods.assertOpen(tx, ctx, businessDate);

    const journal = accountOpeningCorrectionPosting(
      accountCodeFor(input.type, existing.id),
      had,
      wants,
      input.type === 'LOAN',
    );
    if (journal === null) return;

    const today = this.clock.businessDate(ctx.timezone);
    const correctionId = Ulid.generate(this.clock);
    const correctionNumber = await this.numbering.allocate(
      tx,
      ctx,
      'ACCOUNT_OPENING',
      Number(businessDate.slice(0, 4)),
    );

    const corrected = await this.money.correctAccountOpening(tx, ctx, {
      openingId: existing.openingId,
      expectedVersion: existing.openingVersion,
      amountMinor: wants,
      businessDate,
      entryMode: 'CORRECTED',
      correctionId,
      correctionNumber,
      journal: {
        journalEntryId: Ulid.generate(this.clock),
        businessDate,
        entryMode: entryModeFor(businessDate, today),
        sourceType: 'ACCOUNT_OPENING_CORRECTION',
        sourceId: correctionId,
        sourceNumber: correctionNumber,
        lines: journal.lines.map((line) => ({
          id: Ulid.generate(this.clock),
          account: line.account,
          amountMinor: line.amountMinor,
          partyId: line.partyId,
        })),
      },
    });

    if (!corrected) {
      throw new AppError(
        ErrorCode.CONFLICT_STALE_VERSION,
        'Someone else corrected this opening balance while you were editing it',
      );
    }

    await this.audit.append(tx, ctx, {
      entityType: 'account_opening',
      entityId: existing.openingId,
      action: 'CORRECT',
      before: { amountMinor: String(had) },
      after: { amountMinor: String(wants), businessDate },
      source: 'API',
    });
  }

  private async requireAccount(
    tx: Tx,
    ctx: TenantContext,
    accountId: string,
  ): Promise<MoneyAccountRow> {
    const account = await this.money.findAccountById(tx, ctx, accountId);
    if (account === null) throw new AppError(ErrorCode.NOT_FOUND, 'That account no longer exists');

    if (account.type === 'LOAN') await requireLoanVisibility(this.accessControl, tx, ctx);
    else await this.accessControl.require(tx, ctx, viewPermissionFor(account.type));
    return account;
  }
}

function toResponse(row: MoneyAccountRow): MoneyAccountResponse {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    holderName: row.holderName,
    reference: row.reference,
    isDrawer: row.isDrawer,
    status: row.status,
    balanceMinor: row.balanceMinor,
    openingAmountMinor: row.openingAmountMinor,
    openingDate: row.openingDate,
    version: row.version,
  };
}

function sumWhere(
  rows: readonly MoneyAccountRow[],
  predicate: (row: MoneyAccountRow) => boolean,
): number {
  return rows.reduce((sum, row) => (predicate(row) ? sum + row.balanceMinor : sum), 0);
}

/** An empty box on a form means "not given", not an empty string in the column. */
function blankToNull(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}
