/**
 * The four entries Capital & Loans can make (Finance module, 2026-08-31).
 *
 * A module of its own rather than an export from the dialog, because the page
 * decides *which of them this user may make* — from `owner.capital.record` and
 * `loan.movement.record` separately — and a Vue `<script setup>` block cannot
 * export a type for it to import.
 */
export type CapitalEntryKind =
  | 'OWNER_INJECTION'
  | 'OWNER_WITHDRAWAL'
  | 'LOAN_RECEIVED'
  | 'LOAN_REPAYMENT';

/** The owner half and the loan half, each gated by its own permission. */
export const OWNER_ENTRY_KINDS: readonly CapitalEntryKind[] = [
  'OWNER_INJECTION',
  'OWNER_WITHDRAWAL',
];

export const LOAN_ENTRY_KINDS: readonly CapitalEntryKind[] = ['LOAN_RECEIVED', 'LOAN_REPAYMENT'];
