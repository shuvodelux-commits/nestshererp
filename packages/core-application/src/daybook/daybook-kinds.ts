import type { DaybookKind } from '@sher/core-contracts';
import { Permission } from '@sher/core-contracts';

/**
 * Journal source types as a shopkeeper would name them (§5.27).
 *
 * The ledger's vocabulary and the counter's are not the same:
 * `PURCHASE_REVERSAL` is a correct description of an entry and a meaningless
 * phrase to the person who cancelled a bill. Daybook groups the source types
 * into the kinds people recognise, and the filter, the labels and the row
 * actions all key off the kind rather than the raw type.
 */
export const KIND_BY_SOURCE_TYPE: Readonly<Record<string, DaybookKind>> = {
  SALE: 'SALE',
  SALE_CANCELLATION: 'SALE',
  SALES_RETURN: 'SALES_RETURN',
  PURCHASE: 'PURCHASE',
  PURCHASE_REVERSAL: 'PURCHASE',
  PURCHASE_RETURN: 'PURCHASE_RETURN',
  PURCHASE_LANDED_COST: 'PURCHASE',
  CUSTOMER_RECEIPT: 'CUSTOMER_RECEIPT',
  SUPPLIER_PAYMENT: 'SUPPLIER_PAYMENT',
  EXPENSE: 'EXPENSE',
  CASH_MOVEMENT: 'CASH_MOVEMENT',
  STOCK_ADJUSTMENT: 'STOCK_ADJUSTMENT',
  STOCK_COUNT: 'STOCK_COUNT',
  OPENING_STOCK: 'OPENING',
  OPENING_BALANCE: 'OPENING',
  OPENING_BALANCE_CORRECTION: 'OPENING',
  ACCOUNT_OPENING: 'OPENING',
  ACCOUNT_OPENING_CORRECTION: 'OPENING',
  CASH_SESSION_CLOSE: 'DAY_CLOSE',
  CASH_SESSION_REOPEN: 'DAY_CLOSE',
  WARRANTY_CLAIM: 'WARRANTY',
  VENDOR_STOCK_RECEIPT: 'VENDOR_STOCK',
  VENDOR_STOCK_RETURN: 'VENDOR_STOCK',

  /*
   * **Phase 9.2's own entries, which this table had never been told about**
   * (owner-reported 2026-08-31: the ⋯ menu opened as an empty box and the rows
   * read `CUSTOMER_RECEIPT_REVERSAL RCV-2026-000002`).
   *
   * Correcting or cancelling a receipt, a payment, an expense, a cash movement,
   * a stock adjustment or either return writes an entry of its own — and every
   * one of those source types fell through to `OTHER`, which can do nothing and
   * explains nothing. The row then had no actions **and** no reason, which is
   * the one combination that renders as a menu with nothing in it, and its
   * description fell back to the ledger's raw vocabulary — the exact leak this
   * file exists to stop.
   *
   * A reversal and a correction are grouped with the document they belong to,
   * so the filter, the label and the actions all follow the thing a shopkeeper
   * thinks they are looking at.
   */
  CUSTOMER_RECEIPT_REVERSAL: 'CUSTOMER_RECEIPT',
  CUSTOMER_RECEIPT_CORRECTION: 'CUSTOMER_RECEIPT',
  SUPPLIER_PAYMENT_REVERSAL: 'SUPPLIER_PAYMENT',
  SUPPLIER_PAYMENT_CORRECTION: 'SUPPLIER_PAYMENT',
  EXPENSE_REVERSAL: 'EXPENSE',
  EXPENSE_CORRECTION: 'EXPENSE',
  CASH_MOVEMENT_REVERSAL: 'CASH_MOVEMENT',
  CASH_MOVEMENT_CORRECTION: 'CASH_MOVEMENT',
  STOCK_ADJUSTMENT_REVERSAL: 'STOCK_ADJUSTMENT',
  SALES_RETURN_REVERSAL: 'SALES_RETURN',
  PURCHASE_RETURN_REVERSAL: 'PURCHASE_RETURN',
};

export function kindOf(sourceType: string): DaybookKind {
  return KIND_BY_SOURCE_TYPE[sourceType] ?? 'OTHER';
}

/** An entry that undid another one, drawn as the reversal it is (DR4). */
export const REVERSAL_SOURCE_TYPES: readonly string[] = [
  'SALE_CANCELLATION',
  'PURCHASE_REVERSAL',
  'OPENING_BALANCE_CORRECTION',
  'ACCOUNT_OPENING_CORRECTION',
  'CASH_SESSION_REOPEN',
  /*
   * Phase 9.2's reversals, added 2026-08-31 with the kinds above. The
   * `_CORRECTION` halves are deliberately **not** here: a correction reverses
   * and then re-posts under the same number, and this second entry is the
   * document as it now stands — the live thing, which may be corrected again.
   * Only the undoing half is a reversal.
   */
  'CUSTOMER_RECEIPT_REVERSAL',
  'SUPPLIER_PAYMENT_REVERSAL',
  'EXPENSE_REVERSAL',
  'CASH_MOVEMENT_REVERSAL',
  'STOCK_ADJUSTMENT_REVERSAL',
  'SALES_RETURN_REVERSAL',
  'PURCHASE_RETURN_REVERSAL',
];

/**
 * What each kind can be acted on with, and which permission each action needs.
 *
 * **Daybook concentrates visibility, never authority** (§5.27): the codes here
 * are the *owning module's* codes, exactly as if the action had been started
 * from that module's own screen. Nothing here grants anything — the launched
 * use case checks the same code again on the server.
 *
 * `edit` means **correct** (reverse and repost under the same number) and
 * `remove` means **void** (reverse). A posted document is never mutated and
 * never deleted (§2.5), so these two are the only shapes an "edit" or a
 * "delete" can honestly take.
 */
export interface KindCapability {
  readonly open: boolean;
  readonly edit: string | null;
  readonly remove: string | null;
  readonly receivePayment: string | null;
  readonly payBill: string | null;
  readonly returnGoods: string | null;
  /**
   * Phase 11.2 — the four money vouchers that can be moved to another day.
   * Set on those kinds only: a sale or a purchase would also have to move its
   * stock movements and re-run cost layering, so those keep the date field
   * inside their own correction form.
   */
  readonly changeDate: string | null;
  readonly print: boolean;
  /** Set when an action a person expects is not built yet, and says so plainly. */
  readonly note: string | null;
}

const NONE: KindCapability = {
  open: false, edit: null, remove: null, receivePayment: null, payBill: null,
  returnGoods: null, changeDate: null, print: false, note: null,
};

/**
 * **A row offers only what a module can actually do today.**
 *
 * Every `edit` and `remove` here resolves to a correction or a void that
 * exists — Phase 7 gave purchases both, Phase 6 gave a sale its cancellation.
 * Where a module has no correction path yet, the entry is `null` with a `note`
 * saying where the shop does it instead, rather than a menu item that opens a
 * screen with no such button on it. A menu that promises what the server
 * cannot do is worse than a menu that is honest about the gap.
 */
export const CAPABILITIES: Readonly<Record<DaybookKind, KindCapability>> = {
  SALE: {
    ...NONE,
    open: true,
    print: true,
    // An invoice has no edit path: §2.5 corrects one by cancelling it and
    // selling again, which is exactly what the invoice screen offers.
    remove: Permission.SALE_VOID,
    receivePayment: Permission.SALE_RECEIVE_PAYMENT,
    returnGoods: Permission.SALES_RETURN_CREATE,
    note: 'A posted invoice is corrected by cancelling it and making the sale again.',
  },
  PURCHASE: {
    ...NONE,
    open: true,
    print: true,
    edit: Permission.PURCHASE_EDIT,
    remove: Permission.PURCHASE_VOID,
    payBill: Permission.PURCHASE_PAY,
    returnGoods: Permission.PURCHASE_RETURN_CREATE,
  },
  /*
   * Phase 9.2 gave these six their own correction and cancellation paths, so
   * the menu offers what the server can actually do. Correcting rides on the
   * code that recorded the document; cancelling has its own code, because
   * undoing yesterday's receipt is a different act from taking today's (§5.26).
   */
  SALES_RETURN: {
    ...NONE,
    open: true,
    print: true,
    remove: Permission.SALES_RETURN_VOID,
    note: 'A return is corrected by cancelling it and taking it again from the invoice.',
  },
  PURCHASE_RETURN: {
    ...NONE,
    open: true,
    print: true,
    remove: Permission.PURCHASE_RETURN_VOID,
    note: 'A return is corrected by cancelling it and taking it again from the bill.',
  },
  CUSTOMER_RECEIPT: {
    ...NONE,
    changeDate: Permission.TRANSACTION_DATE_CHANGE,
    open: true,
    print: true,
    edit: Permission.SALE_RECEIVE_PAYMENT,
    remove: Permission.RECEIPT_VOID,
  },
  SUPPLIER_PAYMENT: {
    ...NONE,
    changeDate: Permission.TRANSACTION_DATE_CHANGE,
    open: true,
    print: true,
    edit: Permission.PURCHASE_PAY,
    remove: Permission.SUPPLIER_PAYMENT_VOID,
  },
  EXPENSE: {
    ...NONE,
    changeDate: Permission.TRANSACTION_DATE_CHANGE,
    open: true,
    edit: Permission.EXPENSE_RECORD,
    remove: Permission.EXPENSE_VOID,
  },
  CASH_MOVEMENT: {
    ...NONE,
    changeDate: Permission.TRANSACTION_DATE_CHANGE,
    open: true,
    edit: Permission.CASH_MOVEMENT_RECORD,
    remove: Permission.CASH_MOVEMENT_VOID,
  },
  STOCK_ADJUSTMENT: {
    ...NONE,
    open: true,
    // Cancelling puts the goods back exactly where they were and marks the
    // document cancelled (owner decision 2026-08-30, over "post the opposite").
    remove: Permission.STOCK_ADJUSTMENT_VOID,
    note: 'A stock change is corrected by cancelling it and adjusting again.',
  },
  STOCK_COUNT: {
    ...NONE,
    open: true,
    note: 'A count sheet is undone by adjusting the products it corrected, one at a time.',
  },
  OPENING: {
    ...NONE,
    open: true,
    // §2.5 gives an opening its own correction path, which reverses and
    // reposts rather than editing the document — the same shape as here.
    edit: Permission.CUSTOMER_EDIT,
    note: 'An opening balance is corrected on the party or the account it belongs to.',
  },
  DAY_CLOSE: {
    ...NONE,
    open: true,
    note: 'A mistaken close is undone with Reopen Day on Daily Cash, on the same business date.',
  },
  WARRANTY: { ...NONE, open: true },
  VENDOR_STOCK: { ...NONE, open: true },
  OTHER: { ...NONE },
};
