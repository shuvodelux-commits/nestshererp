import { z } from 'zod';

/**
 * Money accounts, the business day and what moves between them (Phase 4,
 * §5.16, §5.17).
 *
 * Money crosses the wire as **integer minor units** with a `Minor` suffix
 * (§5.26, R-C2) — poisha, never a decimal taka.
 *
 * **The wire speaks the ledger's language, not the counter's.** These names are
 * `differenceMinor`, `expectedClosingMinor`, `SHORT`, `REOPENED`. The Bangla a
 * cashier reads — `টাকা কম`, `ভুল করে বন্ধ করেছি` — is presentation, and UI-74
 * is explicit that the domain and API names do not follow the screen. One is
 * for the person counting; the other has to still make sense to an accountant
 * in three years.
 */
const ULID = z.string().length(26);

export const moneyAccountTypeSchema = z.union([
  z.literal('CASH'),
  z.literal('BANK'),
  z.literal('MFS'),
]);
export type MoneyAccountTypeValue = z.infer<typeof moneyAccountTypeSchema>;

export const moneyAccountStatusSchema = z.union([z.literal('ACTIVE'), z.literal('INACTIVE')]);
export type MoneyAccountStatusValue = z.infer<typeof moneyAccountStatusSchema>;

/**
 * Creating an account, opening balance included.
 *
 * The opening is part of the same request rather than a second call because it
 * is part of the same act — a shop adding its bank account on go-live day is
 * saying "this account exists and it has 40,000 in it". Two calls would leave a
 * window in which the account exists with a balance nobody entered yet, and the
 * owner decision of 2026-08-24 (typed on the form, no CSV) is precisely that
 * this should be one small piece of typing.
 *
 * `openingDate` is required only when `openingAmountMinor` is non-zero — the
 * server enforces the pair, because defaulting it to today would date a
 * migrating shop's history to the day they happened to type it.
 */
export const createMoneyAccountRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    type: moneyAccountTypeSchema,
    holderName: z.string().trim().max(80).nullable().default(null),
    reference: z.string().trim().max(64).nullable().default(null),
    /** The one box the day is counted against. Cash only. */
    isDrawer: z.boolean().default(false),
    openingAmountMinor: z.number().int().nonnegative().default(0),
    openingDate: z.string().date().nullable().default(null),
    operationId: ULID,
  })
  .strict();

export type CreateMoneyAccountRequest = z.infer<typeof createMoneyAccountRequestSchema>;

/**
 * Editing an account. `version` is D-32's optimistic lock.
 *
 * The opening balance is here too, and a change to it posts the §2.5 correction
 * delta rather than editing the original entry — the same path a party opening
 * takes, which is why the owner never has to learn two ways to fix a number.
 */
export const updateMoneyAccountRequestSchema = createMoneyAccountRequestSchema
  .omit({ operationId: true })
  .extend({ version: z.number().int().positive() })
  .strict();

export type UpdateMoneyAccountRequest = z.infer<typeof updateMoneyAccountRequestSchema>;

export const moneyAccountResponseSchema = z.object({
  id: ULID,
  name: z.string(),
  type: moneyAccountTypeSchema,
  holderName: z.string().nullable(),
  reference: z.string().nullable(),
  isDrawer: z.boolean(),
  status: moneyAccountStatusSchema,
  /**
   * The INV-07 rollup of this account's journal lines, computed in the same
   * query as the row. Not a stored column — see migration 0016 for why.
   */
  balanceMinor: z.number().int(),
  openingAmountMinor: z.number().int().nullable(),
  openingDate: z.string().nullable(),
  version: z.number().int().positive(),
});

export type MoneyAccountResponse = z.infer<typeof moneyAccountResponseSchema>;

export const moneyAccountListResponseSchema = z.object({
  accounts: z.array(moneyAccountResponseSchema),
  /** What the shop holds in cash and in bank/MFS, so the screen need not add up. */
  totalCashMinor: z.number().int(),
  totalBankMinor: z.number().int(),
});

export type MoneyAccountListResponse = z.infer<typeof moneyAccountListResponseSchema>;

/* --------------------------------------------------------------- the day */

export const cashSessionStatusSchema = z.union([z.literal('OPEN'), z.literal('CLOSED')]);
export type CashSessionStatusValue = z.infer<typeof cashSessionStatusSchema>;

export const cashDifferenceKindSchema = z.union([
  z.literal('MATCHED'),
  z.literal('SHORT'),
  z.literal('OVER'),
]);
export type CashDifferenceKindValue = z.infer<typeof cashDifferenceKindSchema>;

/**
 * Starting the day (§5.16.2).
 *
 * `openingAmountMinor` is what was counted into the drawer, never a suggestion
 * the client accepted on the user's behalf. When it differs from last night's
 * count, `counterpartAccountCode` says where the difference came from or went —
 * `CASH:{id}`, `BANK:{id}` or `OWNER_CURRENT_ACCOUNT` — because §5.16.5 gives
 * cash no "unexplained" option and a sentence cannot be one side of an entry.
 */
export const startDayRequestSchema = z
  .object({
    businessDate: z.string().date(),
    openingAmountMinor: z.number().int().nonnegative(),
    counterpartAccountCode: z.string().min(1).max(80).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
    operationId: ULID,
  })
  .strict();

export type StartDayRequest = z.infer<typeof startDayRequestSchema>;

/**
 * Closing the day (§5.16.4). One counted total — the note-by-note breakdown is
 * deferred behind a setting (owner decision 2026-08-24), so there is
 * deliberately no denominations field here to half-support.
 *
 * `reason` is required by the server whenever the count differs from what the
 * system expected. The client cannot know that before it asks, which is why the
 * field is optional on the wire and mandatory in the use case.
 */
export const closeDayRequestSchema = z
  .object({
    countedClosingMinor: z.number().int().nonnegative(),
    reason: z.string().trim().max(500).nullable().default(null),
    operationId: ULID,
  })
  .strict();

export type CloseDayRequest = z.infer<typeof closeDayRequestSchema>;

/**
 * Undoing a close made by mistake (§5.16.4 as amended 2026-08-24).
 *
 * Only on the current business date, and only for the Owner or the person who
 * performed that close. The reason is required — this is the one action that
 * undoes a posted count, and a day's history that shows two closes without
 * saying why the first was undone is a history that raises the question it
 * exists to answer.
 */
export const reopenDayRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    operationId: ULID,
  })
  .strict();

export type ReopenDayRequest = z.infer<typeof reopenDayRequestSchema>;

/** One close of a day, standing or superseded. */
export const cashSessionCloseResponseSchema = z.object({
  id: ULID,
  status: z.union([z.literal('ACTIVE'), z.literal('SUPERSEDED')]),
  openingAmountMinor: z.number().int(),
  cashInMinor: z.number().int(),
  cashOutMinor: z.number().int(),
  expectedClosingMinor: z.number().int(),
  countedClosingMinor: z.number().int(),
  differenceMinor: z.number().int(),
  differenceKind: cashDifferenceKindSchema,
  differenceReason: z.string().nullable(),
  reopenReason: z.string().nullable(),
  closedAt: z.string(),
  closedByName: z.string().nullable(),
  supersededAt: z.string().nullable(),
});

export type CashSessionCloseResponse = z.infer<typeof cashSessionCloseResponseSchema>;

export const cashSessionResponseSchema = z.object({
  id: ULID,
  number: z.string(),
  accountId: ULID,
  accountName: z.string(),
  businessDate: z.string(),
  status: cashSessionStatusSchema,
  openingAmountMinor: z.number().int(),
  previousClosingMinor: z.number().int().nullable(),
  /** Posted movements so far today, so an open day can show a live expected. */
  cashInMinor: z.number().int(),
  cashOutMinor: z.number().int(),
  expectedClosingMinor: z.number().int(),
  openedAt: z.string(),
  openedByName: z.string().nullable(),
  /**
   * Every close this day has had, newest first. Normally one row; a day closed
   * by mistake and reopened has two, and both stay — that is the point of the
   * amendment (§5.16.4).
   */
  closes: z.array(cashSessionCloseResponseSchema),
  version: z.number().int().positive(),
});

export type CashSessionResponse = z.infer<typeof cashSessionResponseSchema>;

/**
 * What the day chip in the top bar needs, in one call (UI-74: the cashier can
 * always see whether the day is running).
 *
 * `blockedByDate` is the previous day that must be closed first — the whole
 * reason the chip can say "Close 23 Aug first" instead of failing when someone
 * presses Start Day.
 */
export const dayStatusResponseSchema = z.object({
  /** Whether the shop tracks a drawer at all (`cash_session_enabled`). */
  enabled: z.boolean(),
  /** Null when no drawer account has been set up yet. */
  drawerAccountId: ULID.nullable(),
  businessDate: z.string(),
  /**
   * Today's session, open **or** closed — not just an open one.
   *
   * The chip has to be able to offer `ভুল করে বন্ধ করেছি` after the day is
   * closed, and a field that only ever carried an open session could not
   * describe the state in which reopening is the one thing left to do.
   */
  todaySession: cashSessionResponseSchema.nullable(),
  blockedByDate: z.string().nullable(),
  /**
   * The still-open session `blockedByDate` names.
   *
   * The date alone was not enough: the chip could say "close the previous day"
   * and had nothing to close it *with*, so pressing it did nothing at all
   * (owner-reported, 2026-08-25). End Day needs the session — its id, its
   * opening and its expected closing — and this is that session, whatever date
   * it is on.
   */
  blockedSession: cashSessionResponseSchema.nullable(),
  /** The previous day's counted close, which Start Day suggests as the opening. */
  previousClosingMinor: z.number().int().nullable(),
  /**
   * What the drawer's journal lines say it holds right now (INV-07).
   *
   * Start Day measures the counted opening against **this**, not against the
   * previous close: the two are the same on every day after the shop's first,
   * and on the first the ledger is the only honest reference — money in the
   * drawer that the books have never seen still came from somewhere.
   */
  drawerBalanceMinor: z.number().int(),
  /** Whether this user may still undo the standing close (§5.16.4). */
  canReopenToday: z.boolean(),
});

export type DayStatusResponse = z.infer<typeof dayStatusResponseSchema>;

/* --------------------------------------------------------- Daily Cash view */

export const dailyCashRowSchema = z.object({
  sessionId: ULID,
  businessDate: z.string(),
  status: cashSessionStatusSchema,
  openingAmountMinor: z.number().int(),
  cashInMinor: z.number().int(),
  cashOutMinor: z.number().int(),
  expectedClosingMinor: z.number().int().nullable(),
  countedClosingMinor: z.number().int().nullable(),
  differenceMinor: z.number().int().nullable(),
  differenceKind: cashDifferenceKindSchema.nullable(),
  differenceReason: z.string().nullable(),
  /** True when this day was closed, reopened and closed again (§5.16.4). */
  wasReopened: z.boolean(),
});

export type DailyCashRow = z.infer<typeof dailyCashRowSchema>;

export const dailyCashResponseSchema = z.object({
  rows: z.array(dailyCashRowSchema),
  page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
});

export type DailyCashResponse = z.infer<typeof dailyCashResponseSchema>;

/* ---------------------------------------------------------------- movements */

export const cashMovementKindSchema = z.union([
  z.literal('OWNER_INJECTION'),
  z.literal('OWNER_WITHDRAWAL'),
  z.literal('TRANSFER'),
  z.literal('OPENING_ADJUSTMENT'),
]);
export type CashMovementKindValue = z.infer<typeof cashMovementKindSchema>;

/**
 * Recording money moving (§5.16.3, §5.16.5).
 *
 * Both sides are account **codes** rather than ids because one side is often
 * not an account row at all — the owner is `OWNER_CURRENT_ACCOUNT`. A nullable
 * id plus a discriminator would be the same thing with an extra way to be
 * wrong, and §5.16.5's "cash always has a named destination" is exactly the
 * statement that both sides are required.
 *
 * `OPENING_ADJUSTMENT` is not accepted here: it belongs to Start Day, which
 * builds it from the declared counterpart and the difference it computed
 * itself. Letting a client post one directly would let an opening difference be
 * declared without the count that produced it.
 */
export const recordCashMovementRequestSchema = z
  .object({
    kind: z.union([
      z.literal('OWNER_INJECTION'),
      z.literal('OWNER_WITHDRAWAL'),
      z.literal('TRANSFER'),
    ]),
    fromAccountCode: z.string().min(1).max(80),
    toAccountCode: z.string().min(1).max(80),
    amountMinor: z.number().int().positive(),
    businessDate: z.string().date(),
    note: z.string().trim().max(500).nullable().default(null),
    operationId: ULID,
  })
  .strict();

export type RecordCashMovementRequest = z.infer<typeof recordCashMovementRequestSchema>;

/**
 * Correcting a posted movement (Phase 9.2). The whole movement is sent again,
 * not a patch: the server reverses what was posted and re-posts these figures
 * under the same number, so what arrives is what the movement **becomes**.
 *
 * `reason` is optional for a same-day fix — the before and after values are in
 * the audit trail — and required when the correction cannot post on its own
 * date, which is any backdated one and any whose month has closed.
 */
export const correctCashMovementRequestSchema = recordCashMovementRequestSchema
  .omit({ operationId: true })
  .extend({
    version: z.number().int().nonnegative(),
    reason: z.string().trim().max(300).nullable().default(null),
  })
  .strict();

export type CorrectCashMovementRequest = z.infer<typeof correctCashMovementRequestSchema>;


export const cashMovementResponseSchema = z.object({
  id: ULID,
  number: z.string(),
  kind: cashMovementKindSchema,
  fromAccountCode: z.string(),
  fromAccountName: z.string(),
  toAccountCode: z.string(),
  toAccountName: z.string(),
  amountMinor: z.number().int(),
  businessDate: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
});

export type CashMovementResponse = z.infer<typeof cashMovementResponseSchema>;

/* --------------------------------------------------------------- statement */

/**
 * One line of an account's statement — a journal line against `CASH:{id}` or
 * `BANK:{id}`, with a running balance.
 *
 * The same shape the party ledger uses, for the same reason: a statement is a
 * projection of journal lines, recomputed on every read, so there is no stored
 * total that can drift from the postings under it (INV-07, INV-10).
 */
export const accountStatementRowSchema = z.object({
  journalLineId: ULID,
  businessDate: z.string(),
  createdAt: z.string(),
  sourceType: z.string(),
  sourceNumber: z.string(),
  /** Signed: positive is money in, negative is money out. */
  amountMinor: z.number().int(),
  runningBalanceMinor: z.number().int(),
});

export type AccountStatementRow = z.infer<typeof accountStatementRowSchema>;

export const accountStatementResponseSchema = z.object({
  accountId: ULID,
  accountName: z.string(),
  type: moneyAccountTypeSchema,
  openingBalanceMinor: z.number().int(),
  closingBalanceMinor: z.number().int(),
  totalInMinor: z.number().int(),
  totalOutMinor: z.number().int(),
  rows: z.array(accountStatementRowSchema),
  page: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
});

export type AccountStatementResponse = z.infer<typeof accountStatementResponseSchema>;

/* ------------------------------------------------------------- query shapes */

/**
 * The query strings the money endpoints accept.
 *
 * They live here rather than in the controller for the reason every other
 * module's do: the API package does not depend on zod, and a schema defined
 * beside the handler could drift from the response type it feeds.
 */
export const accountListQuerySchema = z
  .object({ includeInactive: z.coerce.boolean().optional() })
  .strict();

export type AccountListQuery = z.infer<typeof accountListQuerySchema>;

export const accountStatementQuerySchema = z
  .object({
    fromDate: z.string().date().optional(),
    toDate: z.string().date().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

export type AccountStatementQuery = z.infer<typeof accountStatementQuerySchema>;

/** Daily Cash reads the same window shape a statement does. */
export const dailyCashQuerySchema = accountStatementQuerySchema;

export type DailyCashQuery = z.infer<typeof dailyCashQuerySchema>;

/** D-32's optimistic lock, on its own, for the actions that carry nothing else. */
export const accountVersionRequestSchema = z
  .object({ version: z.number().int().positive() })
  .strict();

export type AccountVersionRequest = z.infer<typeof accountVersionRequestSchema>;
