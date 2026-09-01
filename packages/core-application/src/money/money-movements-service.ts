import { AppError, ErrorCode, Permission } from '@sher/core-contracts';
import type {
  MoneyMovementGroupValue,
  MoneyMovementListResponse,
  MoneyMovementRow,
  MoneyMovementStatusValue,
} from '@sher/core-contracts';
import type { CashMovementKind, MoneyAccountType } from '@sher/core-domain';

import type { AccessControl } from '../ports/access-control';
import { seesLoans } from './loan-visibility';
import type { TenantContext } from '../ports/tenant-context';
import type { UnitOfWork } from '../ports/unit-of-work';
import { isFeatureOn, settingValuesOf } from '../settings/feature-dependencies';
import { SettingKey } from '@sher/core-contracts';
import type { SettingsRepository } from '../settings/settings-repository';
import type { MoneyRepository, MovementHistoryRow } from './money-repository';

/**
 * The money the shop has moved, as the Finance lists read it (Finance module,
 * owner decisions 2026-08-31).
 *
 * **READ ONLY.** It writes nothing and posts nothing: the Transfer Money page,
 * the two Capital & Loans sections and the Overview's recent list are three
 * views of the movements `CashMovementService` already recorded. A read service
 * is what keeps that true — there is no second way in here to create one.
 *
 * **What a person may see is decided twice.** Once by kind, because owner
 * capital and loans are separate trusts from moving the takings to the bank;
 * and once by account, because a transfer between two bank accounts is not a
 * cashier's business. Both are applied in the query, not after it, so a page of
 * fifty rows is fifty rows this person may read rather than fifty rows with
 * some of them removed.
 */

export interface ListMovementsCommand {
  readonly ctx: TenantContext;
  readonly group?: MoneyMovementGroupValue | undefined;
  readonly accountId?: string | undefined;
  readonly fromDate?: string | undefined;
  readonly toDate?: string | undefined;
  readonly search?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const DEFAULT_LIMIT = 50;

/**
 * Which kinds each list is asking for.
 *
 * `OPENING_ADJUSTMENT` belongs to no group: it is the difference Start Day
 * declared, it is already on the Daily Cash screen that explains it, and a
 * shopkeeper looking at Transfer Money for the deposit they made would have to
 * work out what it was doing there.
 */
const KINDS_IN_GROUP: Record<MoneyMovementGroupValue, readonly CashMovementKind[]> = {
  TRANSFER: ['TRANSFER'],
  OWNER: ['OWNER_INJECTION', 'OWNER_WITHDRAWAL'],
  LOAN: ['LOAN_RECEIVED', 'LOAN_REPAYMENT'],
  ALL: ['TRANSFER', 'OWNER_INJECTION', 'OWNER_WITHDRAWAL', 'LOAN_RECEIVED', 'LOAN_REPAYMENT'],
};

export class MoneyMovementsService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly accessControl: AccessControl,
    private readonly money: MoneyRepository,
    private readonly settings: SettingsRepository,
  ) {}

  async list(command: ListMovementsCommand): Promise<MoneyMovementListResponse> {
    const { ctx } = command;

    return this.uow.run(ctx, async (tx) => {
      const held = await this.accessControl.permissionsOf(tx, ctx);
      const wanted = KINDS_IN_GROUP[command.group ?? 'ALL'];
      const kinds = wanted.filter((kind) => held.includes(readPermissionFor(kind)));

      if (kinds.length === 0) {
        throw new AppError(
          ErrorCode.PERMISSION_DENIED,
          'You do not have permission to see these movements',
        );
      }

      /*
       * The accounts this person may see, by the same rule the account list
       * uses — so a transfer between two bank accounts does not appear for
       * someone who cannot open either of them. A movement is shown only when
       * every account side of it is visible; the owner side is not an account
       * and needs no such test.
       */
      const values = settingValuesOf(await this.settings.listStored(tx, ctx));
      const banksOn = isFeatureOn(values, SettingKey.BANK_ACCOUNTS_ENABLED);
      const types: MoneyAccountType[] = [];
      if (held.includes(Permission.CASH_ACCOUNT_VIEW)) types.push('CASH');
      if (banksOn && held.includes(Permission.BANK_ACCOUNT_VIEW)) types.push('BANK', 'MFS');
      if (seesLoans(held)) types.push('LOAN');

      const visible = await this.money.listAccounts(tx, ctx, {
        types,
        includeInactive: true,
      });

      const limit = command.limit ?? DEFAULT_LIMIT;
      const search = command.search?.trim() ?? '';
      const rows = await this.money.listMovementHistory(tx, ctx, {
        kinds,
        accountId: command.accountId ?? null,
        fromDate: command.fromDate ?? null,
        toDate: command.toDate ?? null,
        search: search === '' ? null : search,
        visibleAccountIds: visible.map((account) => account.id),
        cursor: command.cursor ?? null,
        limit: limit + 1,
      });

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      return {
        rows: page.map(toMovementRow),
        page: {
          nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
          hasMore,
        },
      };
    });
  }
}

/**
 * Reading a kind of movement needs the permission that records it.
 *
 * Deliberately the same code rather than a separate `*.view`: what the owner
 * took out of the business is the figure the owner permission exists to
 * protect, and a read-only view of it would hand over exactly the information
 * the split was made to keep. Transfers are the exception — moving money
 * between the shop's own accounts is visible to anyone who may see those
 * accounts at all, which the account filter below already decides.
 */
function readPermissionFor(kind: CashMovementKind): string {
  switch (kind) {
    case 'OWNER_INJECTION':
    case 'OWNER_WITHDRAWAL':
      return Permission.OWNER_CAPITAL_RECORD;
    case 'LOAN_RECEIVED':
    case 'LOAN_REPAYMENT':
      return Permission.LOAN_MOVEMENT_RECORD;
    default:
      return Permission.CASH_MOVEMENT_RECORD;
  }
}

/**
 * The stored row as a screen reads it.
 *
 * `status` is derived here rather than stored: a movement that was reversed is
 * `VOIDED` in the table and *Cancelled* on the screen, and one that was
 * reversed and re-posted is `POSTED` with a correction reason and reads
 * *Corrected*. The screen never sees either internal word, and never has to be
 * taught that a correction leaves a document posted (UI-21).
 */
function toMovementRow(row: MovementHistoryRow): MoneyMovementRow {
  const status: MoneyMovementStatusValue =
    row.status === 'VOIDED' ? 'CANCELLED' : row.correctionReason === null ? 'POSTED' : 'CORRECTED';

  return {
    id: row.id,
    number: row.number,
    kind: row.kind,
    businessDate: row.businessDate,
    fromAccountCode: row.fromAccountCode,
    fromAccountName: nameOf(row.fromAccountCode, row.fromAccountName),
    toAccountCode: row.toAccountCode,
    toAccountName: nameOf(row.toAccountCode, row.toAccountName),
    amountMinor: row.amountMinor,
    reference: row.reference,
    note: row.note,
    status,
    description: describeMovement(row),
    createdAt: row.createdAt,
    createdByName: row.createdByName,
    version: row.version,
  };
}

/**
 * A side's name, never its code.
 *
 * `OWNER_CURRENT_ACCOUNT` is §2.4's owner current account — the shop's account
 * *with* the owner — and "Owner" is what a person calls it. An account that was
 * deleted after the movement was posted has no row to join, and reads as
 * "(removed account)" rather than as a 26-character id.
 */
function nameOf(code: string, name: string | null): string {
  if (code === 'OWNER_CURRENT_ACCOUNT') return 'Owner';
  return name ?? '(removed account)';
}

/** One line for the Overview list: what happened, in the shopkeeper's words. */
function describeMovement(row: MovementHistoryRow): string {
  const from = nameOf(row.fromAccountCode, row.fromAccountName);
  const to = nameOf(row.toAccountCode, row.toAccountName);

  switch (row.kind) {
    case 'OWNER_INJECTION':
      return `Owner put money in — ${to}`;
    case 'OWNER_WITHDRAWAL':
      return `Owner took money out — ${from}`;
    case 'LOAN_RECEIVED':
      return `Loan received — ${from}`;
    case 'LOAN_REPAYMENT':
      return `Loan repaid — ${to}`;
    case 'OPENING_ADJUSTMENT':
      return 'Opening difference at Start Day';
    default:
      return `${from} → ${to}`;
  }
}
