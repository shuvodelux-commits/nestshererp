import { z } from 'zod';

/**
 * Tenant settings and feature controls (slice 1.5, §5.21).
 *
 * One registry, not a second feature-flag system: §5.21 is explicit that the
 * `modules[]` list in an on-premise licence "feeds the existing Settings
 * module", and D-35 forbids a parallel mechanism. Everything a tenant can turn
 * on, off, or choose between lives in this catalogue and nowhere else.
 *
 * **Keys are static constants**, never built by concatenation — the same rule
 * permission codes follow, and for the same reason: a typo must fail a grep,
 * not silently read a setting that does not exist and get a default.
 */
export const SettingKey = {
  /** D-05 / PART 5A: the two costing choices are separate and each FIFO|AVERAGE. */
  INVENTORY_ISSUE_METHOD: 'inventory_issue_method',
  SALE_COSTING_METHOD: 'sale_costing_method',

  /** §5.21: `BLOCK`/`WARN`/`ALLOW`. */
  NEGATIVE_STOCK_POLICY: 'negative_stock_policy',
  /** PART 5A: "configurable sale policy" for expired stock. */
  EXPIRED_STOCK_SALE_POLICY: 'expired_stock_sale_policy',

  EXPIRY_TRACKING_ENABLED: 'expiry_tracking_enabled',
  EXPIRY_WARN_DAYS: 'expiry_warn_days',
  SERIAL_TRACKING_ENABLED: 'serial_tracking_enabled',
  WARRANTY_ENABLED: 'warranty_enabled',
  PRODUCT_OFFERS_ENABLED: 'product_offers_enabled',

  CUSTOMER_GROUPS_ENABLED: 'customer_groups_enabled',
  WHOLESALE_SALES_ENABLED: 'wholesale_sales_enabled',
  DEALER_PRICING_ENABLED: 'dealer_pricing_enabled',

  VENDOR_MANAGEMENT_ENABLED: 'vendor_management_enabled',
  VENDOR_LEDGER_ENABLED: 'vendor_ledger_enabled',
  VENDOR_CONSIGNMENT_ENABLED: 'vendor_consignment_enabled',

  BANK_ACCOUNTS_ENABLED: 'bank_accounts_enabled',
  BANK_RECONCILIATION_ENABLED: 'bank_reconciliation_enabled',
  CASH_SESSION_ENABLED: 'cash_session_enabled',

  /** PART 5A: "Customer optional fields … configurable visibility". */
  CUSTOMER_FIELD_ADDRESS_VISIBLE: 'customer_field_address_visible',
  CUSTOMER_FIELD_GUARDIAN_VISIBLE: 'customer_field_guardian_visible',
  CUSTOMER_FIELD_NID_VISIBLE: 'customer_field_nid_visible',
  CUSTOMER_FIELD_EMAIL_VISIBLE: 'customer_field_email_visible',
  CUSTOMER_FIELD_NOTES_VISIBLE: 'customer_field_notes_visible',

  /**
   * The Purchase Planner's two day-counts (Phase 8, owner decision
   * 2026-08-26). They are the shop's normal way of buying; the planner shows
   * both at the top of the screen and lets a single trip be planned differently
   * without coming back here.
   */
  PLANNER_LOOK_BACK_DAYS: 'planner_look_back_days',
  PLANNER_COVER_DAYS: 'planner_cover_days',
} as const;

export type SettingKey = (typeof SettingKey)[keyof typeof SettingKey];

/**
 * How a setting is chosen. `TOGGLE` is on/off; `CHOICE` picks one of
 * `options`. There is deliberately no free-text kind: every setting in §5.21 is
 * a closed choice, and a free-text setting is a value nothing can validate.
 */
export type SettingKind = 'TOGGLE' | 'CHOICE';

export interface SettingDescriptor {
  readonly key: SettingKey;
  /** How the screen stacks them. Not stored, not meaningful to the server. */
  readonly group: string;
  readonly label: string;
  readonly detail: string;
  readonly kind: SettingKind;
  /** Allowed values for `CHOICE`. `TOGGLE` is always exactly `on`/`off`. */
  readonly options: readonly string[];
  readonly defaultValue: string;
  /**
   * §5.21's feature dependency table. This setting may only be `on` while every
   * key listed here is also `on`; turning one of those off cascades to this one.
   */
  readonly requires: readonly SettingKey[];
  /**
   * §5.3 step-up: "change costing method · change financial terminology or
   * accounting settings". Changing one of these asks for the caller's password.
   */
  readonly stepUp: boolean;
  /**
   * The module that reads this setting. Until that module ships, the value is
   * stored and audited but nothing consumes it — the screen says so rather than
   * implying an effect the software cannot yet have.
   */
  readonly consumedBy: string;
  /** False while `consumedBy` has not been built. */
  readonly inEffect: boolean;
}

export const TOGGLE_ON = 'on';
export const TOGGLE_OFF = 'off';
const TOGGLE_OPTIONS = [TOGGLE_ON, TOGGLE_OFF] as const;
const COSTING_OPTIONS = ['FIFO', 'AVERAGE'] as const;
const STOCK_POLICY_OPTIONS = ['BLOCK', 'WARN', 'ALLOW'] as const;

/**
 * How long before its date a batch counts as short-dated (owner decision
 * 2026-08-26). A closed list rather than a typed number: the settings machinery
 * has toggles and choices, and a shopkeeper picking from five familiar periods
 * is safer than one typing 3650 by accident.
 */
const EXPIRY_WARN_OPTIONS = ['7', '15', '30', '60', '90'] as const;

/**
 * Closed sets for the planner's two day-counts, like every other number in this
 * catalogue: §5.21 has no free-text kind, and a shop typing 3650 by accident
 * would get a suggestion nobody could pay for.
 */
const PLANNER_LOOK_BACK_OPTIONS = ['7', '15', '30', '60', '90'] as const;
const PLANNER_COVER_OPTIONS = ['7', '15', '30', '45', '60', '90'] as const;

/**
 * Every setting §5.21 and PART 5A define concretely, with the value set each
 * one is allowed to take.
 *
 * Settings §5.21 *names* but does not specify — terminology, numbering
 * prefixes, backdating policy, invoice design and dashboard card visibility —
 * are **absent on purpose**. Their allowed values are nowhere in v4, and
 * inventing them would put a made-up business rule in the database under an
 * SRS-shaped name (R-A5). They arrive with the module that defines them.
 */
export const SETTING_CATALOGUE: readonly SettingDescriptor[] = [
  {
    key: SettingKey.SALE_COSTING_METHOD,
    group: 'Costing',
    label: 'Cost of goods sold method',
    detail:
      'How SherERP works out what a sale cost you. FIFO uses the oldest stock first; Average uses a running average. Accounting valuation follows this choice.',
    kind: 'CHOICE',
    options: COSTING_OPTIONS,
    defaultValue: 'FIFO',
    requires: [],
    stepUp: true,
    consumedBy: 'Inventory & costing',
    inEffect: false,
  },
  {
    key: SettingKey.INVENTORY_ISSUE_METHOD,
    group: 'Costing',
    label: 'Inventory issue method',
    detail:
      'How stock is valued as it leaves. Separate from the sale costing method on purpose — the physical goods always leave oldest-first regardless.',
    kind: 'CHOICE',
    options: COSTING_OPTIONS,
    defaultValue: 'FIFO',
    requires: [],
    stepUp: true,
    consumedBy: 'Inventory & costing',
    inEffect: false,
  },
  {
    key: SettingKey.NEGATIVE_STOCK_POLICY,
    group: 'Stock',
    label: 'Selling more than you have',
    detail:
      'Block refuses the sale. Warn allows it and says so. Allow says nothing. Blocking is safest until your opening stock is accurate.',
    kind: 'CHOICE',
    options: STOCK_POLICY_OPTIONS,
    defaultValue: 'BLOCK',
    requires: [],
    stepUp: false,
    consumedBy: 'Inventory & costing',
    inEffect: false,
  },
  {
    key: SettingKey.EXPIRED_STOCK_SALE_POLICY,
    group: 'Stock',
    label: 'Selling expired stock',
    detail:
      'Block skips expired batches at the counter and refuses when nothing else is left. Warn sells them and says so. Allow says nothing.',
    kind: 'CHOICE',
    options: STOCK_POLICY_OPTIONS,
    defaultValue: 'BLOCK',
    requires: [SettingKey.EXPIRY_TRACKING_ENABLED],
    stepUp: false,
    consumedBy: 'Inventory & costing',
    inEffect: true,
  },
  {
    key: SettingKey.EXPIRY_WARN_DAYS,
    group: 'Stock',
    label: 'Warn when a batch expires within',
    detail:
      'How many days ahead a batch counts as expiring soon. It is shown in amber on the Inventory report; the counter says nothing until a batch has actually expired.',
    kind: 'CHOICE',
    options: EXPIRY_WARN_OPTIONS,
    defaultValue: '30',
    requires: [SettingKey.EXPIRY_TRACKING_ENABLED],
    stepUp: false,
    consumedBy: 'Inventory & costing',
    inEffect: true,
  },
  {
    key: SettingKey.EXPIRY_TRACKING_ENABLED,
    group: 'Stock',
    label: 'Track expiry dates',
    detail: 'Record an expiry date on each batch, and see what is expiring soon.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [],
    stepUp: false,
    consumedBy: 'Inventory & costing',
    inEffect: false,
  },
  {
    key: SettingKey.SERIAL_TRACKING_ENABLED,
    group: 'Stock',
    label: 'Track individual serial numbers',
    detail: 'Follow each unit separately by its serial number, from purchase to sale.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [],
    stepUp: false,
    consumedBy: 'Serial & warranty',
    inEffect: false,
  },
  {
    key: SettingKey.WARRANTY_ENABLED,
    group: 'Stock',
    label: 'Warranty',
    detail: 'Record and look up warranty on the units you sell.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [SettingKey.SERIAL_TRACKING_ENABLED],
    stepUp: false,
    consumedBy: 'Serial & warranty',
    inEffect: false,
  },
  {
    key: SettingKey.PRODUCT_OFFERS_ENABLED,
    group: 'Catalog',
    label: 'Product offers and default discounts',
    detail: 'Set a promotional price or a standing discount on a product. The normal price is kept.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_ON,
    requires: [],
    stepUp: false,
    consumedBy: 'Catalog',
    inEffect: true,
  },
  {
    key: SettingKey.CUSTOMER_GROUPS_ENABLED,
    group: 'Parties',
    label: 'Customer groups',
    detail: 'Sort customers into groups, so a group can be priced differently.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [],
    stepUp: false,
    consumedBy: 'Parties',
    inEffect: false,
  },
  {
    key: SettingKey.WHOLESALE_SALES_ENABLED,
    group: 'Selling',
    label: 'Wholesale sales',
    detail: 'Quotations and orders alongside the counter sale.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [],
    stepUp: false,
    consumedBy: 'Sales & POS',
    inEffect: false,
  },
  {
    key: SettingKey.DEALER_PRICING_ENABLED,
    group: 'Selling',
    label: 'Dealer pricing',
    detail: 'A separate price list for dealers and customer groups.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [SettingKey.WHOLESALE_SALES_ENABLED, SettingKey.CUSTOMER_GROUPS_ENABLED],
    stepUp: false,
    consumedBy: 'Sales & POS',
    inEffect: false,
  },
  {
    key: SettingKey.VENDOR_MANAGEMENT_ENABLED,
    group: 'Parties',
    label: 'Vendors',
    detail: 'Keep vendors separately from suppliers, for goods you sell on their behalf.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [],
    stepUp: false,
    consumedBy: 'Parties',
    inEffect: false,
  },
  {
    key: SettingKey.VENDOR_LEDGER_ENABLED,
    group: 'Parties',
    label: 'Vendor ledger',
    detail: 'A running account of what you owe each vendor.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [SettingKey.VENDOR_MANAGEMENT_ENABLED],
    stepUp: false,
    consumedBy: 'Ledgers',
    inEffect: false,
  },
  {
    key: SettingKey.VENDOR_CONSIGNMENT_ENABLED,
    group: 'Parties',
    label: 'Consignment stock',
    detail:
      "Sell goods you have not bought yet. Selling one creates the purchase from the vendor at the same moment.",
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [SettingKey.VENDOR_MANAGEMENT_ENABLED, SettingKey.VENDOR_LEDGER_ENABLED],
    stepUp: false,
    consumedBy: 'Purchasing extras',
    inEffect: false,
  },
  {
    key: SettingKey.BANK_ACCOUNTS_ENABLED,
    group: 'Money',
    label: 'Bank accounts',
    detail: 'Record money that moves through a bank account rather than the drawer.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [],
    stepUp: false,
    consumedBy: 'Money accounts',
    inEffect: false,
  },
  {
    key: SettingKey.BANK_RECONCILIATION_ENABLED,
    group: 'Money',
    label: 'Bank reconciliation',
    detail: 'Match your bank statement against what SherERP recorded.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [SettingKey.BANK_ACCOUNTS_ENABLED],
    stepUp: false,
    consumedBy: 'Bank reconciliation',
    inEffect: false,
  },
  {
    key: SettingKey.CASH_SESSION_ENABLED,
    group: 'Money',
    label: 'Start and end the business day',
    detail:
      'Count the drawer at the start and end of each day, and see any shortage or surplus.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_ON,
    requires: [],
    stepUp: false,
    consumedBy: 'Money accounts',
    inEffect: false,
  },
  {
    key: SettingKey.CUSTOMER_FIELD_ADDRESS_VISIBLE,
    group: 'Customer fields',
    label: 'Ask for an address',
    detail: 'Show the address field when adding or editing a customer.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_ON,
    requires: [],
    stepUp: false,
    consumedBy: 'Parties',
    inEffect: false,
  },
  {
    key: SettingKey.CUSTOMER_FIELD_GUARDIAN_VISIBLE,
    group: 'Customer fields',
    label: "Ask for a father's or guardian's name",
    detail:
      'Show the father/guardian field when adding or editing a customer, supplier or vendor.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    /*
     * On by default — owner decision, 2026-08-24. In Bangladesh a father's or
     * guardian's name is how two people with the same common name are told
     * apart, so a shop that cannot see the field on the form reads it as the
     * field not existing. Switching it off is still one tap for a shop that
     * does not want it, and §5.6 guarantees a stored value survives that.
     */
    defaultValue: TOGGLE_ON,
    requires: [],
    stepUp: false,
    consumedBy: 'Parties',
    inEffect: false,
  },
  {
    key: SettingKey.CUSTOMER_FIELD_NID_VISIBLE,
    group: 'Customer fields',
    label: 'Ask for an NID number',
    detail: 'Show the National ID field when adding or editing a customer.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [],
    stepUp: false,
    consumedBy: 'Parties',
    inEffect: false,
  },
  {
    key: SettingKey.CUSTOMER_FIELD_EMAIL_VISIBLE,
    group: 'Customer fields',
    label: 'Ask for an email address',
    detail: 'Show the email field when adding or editing a customer.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    defaultValue: TOGGLE_OFF,
    requires: [],
    stepUp: false,
    consumedBy: 'Parties',
    inEffect: false,
  },
  {
    key: SettingKey.CUSTOMER_FIELD_NOTES_VISIBLE,
    group: 'Customer fields',
    label: 'Ask for a description',
    detail:
      'Show a free-text description/notes field when adding or editing a customer, supplier or vendor.',
    kind: 'TOGGLE',
    options: TOGGLE_OPTIONS,
    /* On by default — owner decision, 2026-08-24, with the guardian field. */
    defaultValue: TOGGLE_ON,
    requires: [],
    stepUp: false,
    consumedBy: 'Parties',
    inEffect: false,
  },
  {
    key: SettingKey.PLANNER_LOOK_BACK_DAYS,
    group: 'Purchasing',
    label: 'Measure how fast things sell over',
    detail:
      'How many days of sales the purchase planner looks back at to work out how fast a product moves. A product that sold on fewer than three separate days falls back to its minimum stock level instead.',
    kind: 'CHOICE',
    options: PLANNER_LOOK_BACK_OPTIONS,
    defaultValue: '30',
    requires: [],
    stepUp: false,
    consumedBy: 'Purchasing',
    inEffect: true,
  },
  {
    key: SettingKey.PLANNER_COVER_DAYS,
    group: 'Purchasing',
    label: 'Keep enough stock to last',
    detail:
      'How many days of stock the purchase planner buys up to. It also sets the urgency bands: a quarter of this is Critical and half of it is High.',
    kind: 'CHOICE',
    options: PLANNER_COVER_OPTIONS,
    defaultValue: '30',
    requires: [],
    stepUp: false,
    consumedBy: 'Purchasing',
    inEffect: true,
  },
];

/** IANA zone names SherERP offers. Default `Asia/Dhaka` (§3.5). */
export const SUPPORTED_TIMEZONES = ['Asia/Dhaka'] as const;

export const settingDescriptorSchema = z
  .object({
    key: z.string(),
    group: z.string(),
    label: z.string(),
    detail: z.string(),
    kind: z.union([z.literal('TOGGLE'), z.literal('CHOICE')]),
    options: z.array(z.string()),
    defaultValue: z.string(),
    requires: z.array(z.string()),
    stepUp: z.boolean(),
    consumedBy: z.string(),
    inEffect: z.boolean(),
  })
  .strict();

export type SettingDescriptorResponse = z.infer<typeof settingDescriptorSchema>;

/**
 * The whole settings screen in one response: the business profile, the
 * catalogue that describes every control, and the tenant's current values.
 *
 * The catalogue travels with the values for the same reason it does on the
 * roles screen — so the client can render a control it has never heard of, and
 * can never offer one the server would refuse.
 */
export const settingsResponseSchema = z
  .object({
    businessName: z.string(),
    timezone: z.string(),
    supportedTimezones: z.array(z.string()),
    catalogue: z.array(settingDescriptorSchema),
    values: z.record(z.string(), z.string()),
  })
  .strict();

export type SettingsResponse = z.infer<typeof settingsResponseSchema>;

/**
 * One change at a time. A screen that saved every setting at once would write
 * an audit row per key on every save and make the trail unreadable — and §5.22
 * wants the trail to say what the owner actually changed.
 *
 * `confirmPassword` is present only for the settings whose descriptor says
 * `stepUp` (§5.3). The server decides; a client that omits it is refused.
 */
export const updateSettingRequestSchema = z
  .object({
    key: z.string().min(1).max(80),
    value: z.string().min(1).max(80),
    confirmPassword: z.string().min(1).max(200).optional(),
  })
  .strict();

export type UpdateSettingRequest = z.infer<typeof updateSettingRequestSchema>;

export const updateBusinessProfileRequestSchema = z
  .object({
    businessName: z.string().min(2).max(120),
    timezone: z.string().min(1).max(60),
  })
  .strict();

export type UpdateBusinessProfileRequest = z.infer<typeof updateBusinessProfileRequestSchema>;
