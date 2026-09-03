import { z } from 'zod';

/**
 * Server-controlled feature flags (§19), and the hard line around them.
 *
 * A flag may hide a screen, disable a button, or switch off an optional
 * feature. A flag may **not** change what a posting means. Costing method,
 * journal behaviour, VAT rules, period rules and anything the ledger depends on
 * are not read through this mechanism at all — not "are not currently flagged",
 * but have no flag lookup in their code path — so there is no switch to throw
 * and no accident to have.
 *
 * That distinction matters more than it looks. A flag that could retroactively
 * change costing would make two audits of the same month disagree, with no
 * record of why, and the shop would have no way to tell which answer was ever
 * true.
 *
 * **Unreachable means enabled.** If the control plane is down or the shop's
 * line is out, every flag resolves to its enabled default (§20, §21). A vendor
 * outage must never be able to switch a customer's features off — the failure
 * mode of a management channel has to be "no management", not "less ERP".
 */
export const featureFlagSchema = z
  .object({
    key: z.string().min(1).max(64),
    enabled: z.boolean(),
    /** Why it was flipped. Required for an emergency disable (§24). */
    reason: z.string().max(500).default(''),
  })
  .strict();
export type FeatureFlag = z.infer<typeof featureFlagSchema>;

export const featureFlagSetSchema = z
  .object({
    flags: z.array(featureFlagSchema).max(200),
    issued_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type FeatureFlagSet = z.infer<typeof featureFlagSetSchema>;

/**
 * The flags this build knows about, and what they hide.
 *
 * A flag not on this list is ignored by the ERP. That keeps the mechanism from
 * becoming a general remote-configuration channel: the vendor can only turn off
 * things somebody deliberately made turn-off-able.
 */
export const KNOWN_FEATURE_FLAGS: readonly string[] = [
  'quotations',
  'sales_orders',
  'purchase_planner',
  'bank_reconciliation_ui',
  'stock_count_sheet',
  'vendor_workspace',
];
