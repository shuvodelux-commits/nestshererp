export const MANAGE_ACCOUNTS_SERVICE = Symbol('ManageAccountsService');
export const CASH_SESSION_SERVICE = Symbol('CashSessionService');
export const CASH_MOVEMENT_SERVICE = Symbol('CashMovementService');
export const DAILY_CASH_SERVICE = Symbol('DailyCashService');

// Finance module — the read side of what the shop has moved (§5.16.3).
export const MONEY_MOVEMENTS_SERVICE = Symbol('MoneyMovementsService');

// Phase 11 — reconciling an account against the bank's own statement (§5.17).
export const RECONCILE_ACCOUNT_SERVICE = Symbol('ReconcileAccountService');
export const IMPORT_STATEMENT_SERVICE = Symbol('ImportStatementService');
