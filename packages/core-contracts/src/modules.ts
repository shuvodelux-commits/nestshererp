import type { LicensableModuleCode } from './license-key';
import { Permission } from './permissions';

/**
 * The parts of SherERP a licence can include or leave out (§5.4, D-35, owner
 * decision 2026-08-30).
 *
 * **Not a second feature-flag system.** D-35 is explicit that `modules[]` feeds
 * the chain everything else already uses — Plan → Feature → Setting →
 * Permission → Access. This registry is the first link: it says which permission
 * codes belong to which purchasable module, so the existing access control can
 * answer "the licence does not include this" in the same place it already
 * answers "your role does not include this".
 *
 * **Most of SherERP is not in here, and that is the point.** Products, parties,
 * purchases, sales, inventory, money, expenses, returns, periods, users,
 * settings, audit, the daybook, the dashboard, and backup itself are *core*: a
 * licence cannot take them away, because a business that cannot sell or take
 * money is not running SherERP at all. What a licence buys is the layer above
 * that — the §5.4 tiers name reconciliation and reporting as Medium, and
 * vendor/consignment, serial and warranty as Advanced.
 *
 * A licence listing no modules at all means **everything**, matching
 * `Entitlement.modules` from Phase 1.7. That is what an unrestricted licence
 * looks like, and it is also what keeps a module built after a licence was
 * issued from being silently withheld.
 */
export interface LicensedModule {
  /**
   * The string a licence's `modules[]` carries.
   *
   * Typed against the list the licence format declares, so this registry and
   * what the issuing CLI can tick cannot drift apart without the build saying
   * so — the alternative is a licence sold with a module code the server has
   * never heard of, which fails silently as "not included".
   */
  readonly code: LicensableModuleCode;
  readonly label: string;
  readonly labelBn: string;
  /**
   * Reading this module's own records. Still permitted when the licence
   * excludes the module **and the business has data in it** — §5.4 and D-36:
   * historical data is retained, and no state hides a shop's own records.
   */
  readonly readPermissions: readonly string[];
  /**
   * Creating or changing. Refused while the licence excludes the module, no
   * matter what the role holds. This is the whole of "new writes remain
   * blocked until the licence again includes that module".
   */
  readonly writePermissions: readonly string[];
  /**
   * Writes that **finish** something rather than start it — returning goods that
   * belong to somebody else, closing a claim already taken in.
   *
   * Permitted while the licence excludes the module **and the business holds
   * records in it**, and refused outright otherwise. A lapsed licence must not
   * strand a real obligation: a vendor's stock sitting on the shelf has to be
   * returnable, and a customer's phone taken in under warranty has to be
   * givable back. Money owed to or from a vendor is not listed here because
   * paying and being paid were never licensable — they are core.
   *
   * **Known limit, and it is deliberate.** Some modules still have one `manage`
   * code covering both the new receipt and the return, so listing it here lets
   * a shop that already holds vendor stock keep receiving more of it. Freezing
   * the unwind was the worse of the two: it holds another business's goods
   * hostage over a renewal. Splitting those codes belongs to those modules.
   */
  readonly unwindPermissions: readonly string[];
  /**
   * The tables whose rows mean "this business has used this module".
   *
   * Table names in a contract package look out of place until you ask the
   * question they answer: *has this shop got records here?* That is a fact
   * about the business, not about Postgres, and the alternative — a probe
   * hand-written per module in the adapter — is the list that drifts.
   */
  readonly dataTables: readonly string[];
}

export const LICENSED_MODULES: readonly LicensedModule[] = [
  {
    code: 'BANK_RECONCILIATION',
    label: 'Bank reconciliation',
    labelBn: 'ব্যাংক মেলানো',
    readPermissions: [Permission.RECONCILIATION_VIEW],
    writePermissions: [Permission.RECONCILIATION_PERFORM, Permission.RECONCILIATION_REOPEN],
    unwindPermissions: [],
    dataTables: ['account_reconciliations', 'bank_statement_files', 'statement_lines'],
  },
  {
    code: 'ADVANCED_REPORTS',
    label: 'Reports',
    labelBn: 'রিপোর্ট',
    /*
     * The four report screens and the profit figure. The dashboard is core —
     * a shop opening SherERP to a blank page because reporting was not bought
     * would look broken rather than unlicensed.
     */
    readPermissions: [
      Permission.REPORT_SALES_VIEW,
      Permission.REPORT_PURCHASE_VIEW,
      Permission.REPORT_STOCK_VIEW,
      Permission.REPORT_MONEY_VIEW,
      Permission.REPORT_PROFIT_VIEW,
    ],
    writePermissions: [Permission.REPORT_TARGET_MANAGE],
    /*
     * Reports read other modules' tables and own almost nothing; the monthly
     * target is the one thing a shop can have *put into* reporting, so it is
     * the only honest answer to "have they used this".
     */
    unwindPermissions: [],
    dataTables: ['profit_targets'],
  },
  {
    code: 'PURCHASE_PLANNING',
    label: 'Purchase planner',
    labelBn: 'কেনার পরিকল্পনা',
    readPermissions: [Permission.PURCHASE_PLAN_VIEW],
    writePermissions: [Permission.PURCHASE_PLAN_MANAGE],
    unwindPermissions: [],
    dataTables: ['purchase_plans', 'supplier_purchase_orders'],
  },
  {
    code: 'WARRANTY_SERIAL',
    label: 'Warranty & serials',
    labelBn: 'ওয়ারেন্টি ও সিরিয়াল',
    readPermissions: [Permission.WARRANTY_CLAIM_VIEW],
    writePermissions: [Permission.WARRANTY_CLAIM_MANAGE],
    // Handing back a phone taken in under warranty is finishing, not starting.
    unwindPermissions: [Permission.WARRANTY_CLAIM_MANAGE],
    dataTables: ['warranty_claims', 'inventory_units'],
  },
  {
    code: 'VENDOR_STOCK',
    label: 'Vendor stock',
    labelBn: 'ভেন্ডরের মাল',
    /*
     * Seeing a vendor is party data and stays with the parties module; what
     * this licence buys is holding somebody else's goods on your shelf.
     */
    readPermissions: [],
    writePermissions: [Permission.VENDOR_STOCK_MANAGE],
    // Returning goods that belong to the vendor, so they are never stranded here.
    unwindPermissions: [Permission.VENDOR_STOCK_MANAGE],
    dataTables: ['vendor_stock_receipts', 'vendor_stock_returns'],
  },
];

/** The module a permission belongs to, or null when it is core. */
export function moduleOwning(permissionCode: string): LicensedModule | null {
  return (
    LICENSED_MODULES.find(
      (module) =>
        module.readPermissions.includes(permissionCode) ||
        module.writePermissions.includes(permissionCode) ||
        module.unwindPermissions.includes(permissionCode),
    ) ?? null
  );
}

/** Whether the licence's `modules[]` covers a module. Empty means everything. */
export function licenceIncludes(licensedModules: readonly string[], code: string): boolean {
  return licensedModules.length === 0 || licensedModules.includes(code);
}
