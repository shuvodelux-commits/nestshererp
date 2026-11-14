import { createPurchaseRequestSchema, purchaseInitialPaymentLegsSchema } from './purchasing';

/**
 * MOD-008 D06C1-B0, issue #224 — NOT A LIVE PURCHASE ROUTE.
 *
 * The future multi-account purchase-create request is a mutually exclusive
 * *payment-only* branch of the current legacy request. Derive all shared
 * header, line, cost, date, correction and supplier-order validators from the
 * live schema to prevent silent drift, and replace ONLY the payment mode.
 *
 * paymentLegs is required even for an unpaid bill ([]); never silently
 * interpret a missing array as "pay nothing". Reject both legacy paid fields,
 * including zero/null, and the superseded "payments" name via strict parsing.
 *
 * Account codes remain UNTRUSTED input. This schema does not authorize
 * balances, sessions, period or tenant identity, and cannot check payment sum
 * against server-derived grand total. The future Class-T writer must call the
 * real tenant-locked resolver, post all original legs and store their immutable
 * source provenance in the same PostgreSQL transaction.
 *
 * This is deliberately limited to existing qty/unitPriceMinor lines. The
 * independent multilevel entered-unit pricing branch is separately gated by
 * D03/D16 and must not be silently discarded or treated as implemented here.
 *
 * This module is NOT re-exported from core-contracts/index.ts and is NOT
 * imported into POST /api/v1/purchases. The live legacy request stays strict.
 */
export const purchaseCreatePaymentLegBranchSchema = createPurchaseRequestSchema
  .omit({
    paidMinor: true,
    paidAccountCode: true,
  })
  .extend({
    paymentLegs: purchaseInitialPaymentLegsSchema,
  })
  .strict();

export type PurchaseCreatePaymentLegBranch = typeof purchaseCreatePaymentLegBranchSchema['_output'];
