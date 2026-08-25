/**
 * Permission codes: `{module}.{resource}.{action}`, static constants (§5.26).
 * Never built by string concatenation at runtime — a typo would silently grant
 * or deny, and a grep must find every use site.
 */
export const Permission = {
  /** Reference use case for the R-D write path; replaced by real codes from Phase 1. */
  NOTE_CREATE: 'demo.note.create',
  NOTE_VIEW: 'demo.note.view',

  /**
   * User administration (slice 1.3). Create, edit and disable are **separate
   * codes**, not one `user.account.manage`: §5.26 is explicit that destructive
   * and financially meaningful actions get their own code, and being able to add
   * a cashier is a smaller thing than being able to disable the manager.
   */
  USER_VIEW: 'user.account.view',
  USER_CREATE: 'user.account.create',
  USER_EDIT: 'user.account.edit',
  USER_DISABLE: 'user.account.disable',

  /**
   * Roles themselves (slice 1.4). Editing what a role may do re-privileges
   * everyone holding it at once, which is why it is its own code and not folded
   * into `user.account.edit`.
   */
  ROLE_VIEW: 'user.role.view',
  ROLE_MANAGE: 'user.role.manage',

  /**
   * Settings and feature controls (slice 1.5, §5.21).
   *
   * Three codes, not one. §5.26 keeps "destructive and financially meaningful
   * actions" on their own code, and the three acts here are not the same size:
   * reading what the shop is configured to do, choosing how a running feature
   * behaves, and switching a whole module off for everybody. `settings.module.toggle`
   * is the name §5.26 gives the last of those.
   */
  SETTING_VIEW: 'settings.setting.view',
  SETTING_EDIT: 'settings.setting.edit',
  SETTING_TOGGLE: 'settings.module.toggle',

  /**
   * The audit trail (slice 1.6, §5.22).
   *
   * View only — there is no write, edit or delete code, because the trail is
   * append-only and "audit logging cannot be disabled by configuration"
   * (§5.26). A permission to change it would be a permission to forge history.
   */
  AUDIT_VIEW: 'audit.event.view',

  /**
   * Product and catalog (Phase 2, §5.5). View, create and edit are separate
   * codes for the reason §5.26 gives: a cashier must be able to find a product
   * without being able to change what it sells for.
   *
   * Deactivate and delete are their own codes and are not folded into edit —
   * §5.26 keeps "destructive and financially meaningful actions" apart, and
   * taking a product out of the POS list affects every person selling today.
   */
  PRODUCT_VIEW: 'catalog.product.view',
  PRODUCT_CREATE: 'catalog.product.create',
  PRODUCT_EDIT: 'catalog.product.edit',
  PRODUCT_DEACTIVATE: 'catalog.product.deactivate',
  PRODUCT_DELETE: 'catalog.product.delete',

  /**
   * The vocabulary products are described with. One code each, because a shop
   * that lets a storekeeper file goods under a new category does not thereby
   * let them invent a unit of measure every conversion rule then depends on.
   *
   * Reading them needs no code of its own: the product form cannot be drawn
   * without them, so `catalog.product.view` is what admits a caller.
   */
  BRAND_MANAGE: 'catalog.brand.manage',
  CATEGORY_MANAGE: 'catalog.category.manage',
  UNIT_MANAGE: 'catalog.unit.manage',

  /**
   * Cost visibility, named exactly as §5.26 names it.
   *
   * This is not a UI preference. Without it, purchase price is **absent from
   * the API response** (UI-40, R-E8) — not blanked in Vue, where anyone could
   * read it in the network tab. It is separate from `catalog.product.edit`
   * because a shopkeeper may well let staff fix a spelling without showing them
   * what the goods cost.
   */
  COST_VIEW: 'inventory.cost.view',
  INVENTORY_LOT_VIEW: 'inventory.lot.view',
  INVENTORY_COST_RECOMPUTE: 'inventory.cost.recompute',

  /**
   * Parties (Phase 2, §5.6, D-04). Customers, suppliers and vendors are three
   * codes over one table, because they are three different trusts: the cashier
   * who adds a customer at the counter has no business adding a supplier, and
   * §5.6 keeps vendor/consignment behind its own feature setting as well.
   */
  CUSTOMER_VIEW: 'party.customer.view',
  CUSTOMER_CREATE: 'party.customer.create',
  CUSTOMER_EDIT: 'party.customer.edit',
  CUSTOMER_DEACTIVATE: 'party.customer.deactivate',

  SUPPLIER_VIEW: 'party.supplier.view',
  SUPPLIER_CREATE: 'party.supplier.create',
  SUPPLIER_EDIT: 'party.supplier.edit',
  SUPPLIER_DEACTIVATE: 'party.supplier.deactivate',

  VENDOR_VIEW: 'party.vendor.view',
  VENDOR_CREATE: 'party.vendor.create',
  VENDOR_EDIT: 'party.vendor.edit',
  VENDOR_DEACTIVATE: 'party.vendor.deactivate',

  /** Customer groups (§5.6), the classification dealer pricing will later use. */
  PARTY_GROUP_MANAGE: 'party.group.manage',

  /**
   * Running a master-data CSV import (§5.6 "Opening-data import").
   *
   * Its own code **on top of** the create permission for whatever is being
   * imported. Adding one customer and posting a file of four hundred are not
   * the same act: the second is how a bad file becomes four hundred bad rows,
   * and it is a migration/onboarding action rather than daily work.
   */
  IMPORT_RUN: 'data.import.run',

  /**
   * Money accounts and the business day (Phase 4, §5.16, §5.17).
   *
   * **Seeing an account and creating one are far apart**, which is why they are
   * separate codes: a cashier must know how much is in the drawer to do their
   * job, and creating a bank account is the shop's banking arrangement.
   *
   * `CASH_SESSION_REOPEN` is its own code because it is the one action that
   * undoes a posted count. Owner decision 2026-08-24 gives it to the Owner and,
   * separately from any role, to whoever performed that close — the second half
   * is a rule the use case applies on top of this code, not a permission a role
   * can hold, since "the person who did it" is not knowable from a role.
   */
  CASH_ACCOUNT_VIEW: 'cash.account.view',
  CASH_ACCOUNT_MANAGE: 'cash.account.manage',
  CASH_SESSION_START: 'cash.session.start',
  CASH_SESSION_CLOSE: 'cash.session.close',
  CASH_SESSION_REOPEN: 'cash.session.reopen',
  CASH_MOVEMENT_RECORD: 'cash.movement.record',
  CASH_DAILY_VIEW: 'cash.daily.view',
  CASH_DAILY_INVESTIGATE: 'cash.daily.investigate',

  BANK_ACCOUNT_VIEW: 'bank.account.view',
  BANK_ACCOUNT_MANAGE: 'bank.account.manage',

  /**
   * Buying goods (Phase 5, §5.9).
   *
   * Three codes rather than one `purchase.manage`, by the owner decision of
   * 2026-08-24: entering a delivery and handing over money are different
   * sizes of trust. A shop with a stock-keeper can let them record what
   * arrived without also letting them empty the drawer, which is the split
   * §5.26 asks for on financially meaningful actions.
   */
  PURCHASE_VIEW: 'purchase.bill.view',
  PURCHASE_CREATE: 'purchase.bill.create',
  PURCHASE_PAY: 'purchase.payment.record',

  /*
   * Selling (§5.7, §5.8, §5.26). The split mirrors purchasing: recording a sale
   * is the counter's daily work, taking money against old dues is a second
   * decision, and changing a price or a posted invoice is a third — a cashier
   * who may sell at the marked price has no business discounting it or voiding
   * yesterday's invoice.
   *
   * `SALE_PRESENTATION_EDIT` is deliberately its own code and deliberately not
   * `SALE_EDIT`: it changes what an invoice *says* — a display name, a courier,
   * a note — and can reach no quantity, price, payment or journal figure, which
   * is exactly why the person who prints invoices can hold it safely.
   */
  SALE_VIEW: 'sale.invoice.view',
  SALE_CREATE: 'sale.invoice.create',
  SALE_EDIT: 'sale.invoice.edit',
  SALE_VOID: 'sale.invoice.void',
  SALE_RECEIVE_PAYMENT: 'sale.payment.record',
  SALE_PRICE_EDIT: 'sale.price.edit',
  SALE_DISCOUNT_APPLY: 'sale.discount.apply',
  SALE_PRESENTATION_EDIT: 'invoice.presentation.edit',
  SALE_QUOTATION_MANAGE: 'sale.quotation.manage',
  SALE_ORDER_MANAGE: 'sale.order.manage',

  /**
   * Corrections and adjustments (Phase 7, owner decisions 2026-08-26).
   *
   * One code per action, because a shop must be able to let a cashier take a
   * customer's goods back without also letting them void a supplier's bill or
   * close a month. **How much cash a return may hand back is not a permission
   * but a number on the role** — `cashRefundPerReturnMinor` and
   * `cashRefundPerDayMinor` — because the answer is an amount, not a yes or no,
   * and a permission per bracket would be a permission per shop.
   */
  SALES_RETURN_VIEW: 'sales.return.view',
  SALES_RETURN_CREATE: 'sales.return.create',
  PURCHASE_RETURN_VIEW: 'purchase.return.view',
  PURCHASE_RETURN_CREATE: 'purchase.return.create',
  PURCHASE_EDIT: 'purchase.bill.edit',
  PURCHASE_VOID: 'purchase.bill.void',
  EXPENSE_VIEW: 'expense.view',
  EXPENSE_RECORD: 'expense.record',
  STOCK_COUNT_POST: 'stock.count.post',
  PERIOD_CLOSE: 'period.close',
  PERIOD_BACKDATE: 'period.backdate',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

/**
 * Every permission with a name a shopkeeper can read, for the roles screen.
 *
 * It lives beside the codes so a new code cannot be added without deciding what
 * to call it — a tick-box labelled `user.account.disable` is not a choice
 * anybody can make responsibly. `group` is only how the screen stacks them.
 *
 * These strings become i18n keys when the i18n layer lands (UI-18); nothing in
 * the app is keyed yet, so they are plain English like every other string.
 */
export interface PermissionDescriptor {
  readonly code: Permission;
  readonly group: string;
  readonly label: string;
  readonly detail: string;
}

export const PERMISSION_CATALOGUE: readonly PermissionDescriptor[] = [
  {
    code: Permission.USER_VIEW,
    group: 'People',
    label: 'See the user list',
    detail: 'Open the Users screen and see who works here.',
  },
  {
    code: Permission.USER_CREATE,
    group: 'People',
    label: 'Add users',
    detail: 'Create an account for someone new.',
  },
  {
    code: Permission.USER_EDIT,
    group: 'People',
    label: 'Edit users',
    detail: 'Change a name, or move someone to a different role.',
  },
  {
    code: Permission.USER_DISABLE,
    group: 'People',
    label: 'Disable users',
    detail: 'Stop an account signing in, and sign it out everywhere.',
  },
  {
    code: Permission.ROLE_VIEW,
    group: 'Roles',
    label: 'See roles',
    detail: 'Open the Roles screen and see what each role may do.',
  },
  {
    code: Permission.ROLE_MANAGE,
    group: 'Roles',
    label: 'Change what roles may do',
    detail: 'Create roles and change their permissions. This changes what other people can do.',
  },
  {
    code: Permission.SETTING_VIEW,
    group: 'Settings',
    label: 'See settings',
    detail: 'Open the Settings screen and see how the business is set up.',
  },
  {
    code: Permission.SETTING_EDIT,
    group: 'Settings',
    label: 'Change settings',
    detail:
      'Change the business name, the timezone, and how features behave — including the costing method, which decides what every sale is recorded as costing.',
  },
  {
    code: Permission.SETTING_TOGGLE,
    group: 'Settings',
    label: 'Turn features on and off',
    detail:
      'Switch whole parts of SherERP on or off for everyone. Turning one off also turns off anything that depends on it.',
  },
  {
    code: Permission.AUDIT_VIEW,
    group: 'Audit',
    label: 'See the audit trail',
    detail:
      'Open the Audit screen and see every change anyone has made, with what it was before and after.',
  },

  {
    code: Permission.PRODUCT_VIEW,
    group: 'Products',
    label: 'See products',
    detail: 'Open the Products screen, search the catalog and see selling prices.',
  },
  {
    code: Permission.PRODUCT_CREATE,
    group: 'Products',
    label: 'Add products',
    detail: 'Create a new product, with its unit, prices and reorder level.',
  },
  {
    code: Permission.PRODUCT_EDIT,
    group: 'Products',
    label: 'Edit products',
    detail:
      'Change a product — including what it sells for, and any standing discount or offer.',
  },
  {
    code: Permission.PRODUCT_DEACTIVATE,
    group: 'Products',
    label: 'Deactivate and reactivate products',
    detail:
      'Take a product out of new sales and purchases, or put it back. Its history stays exactly as it is.',
  },
  {
    code: Permission.PRODUCT_DELETE,
    group: 'Products',
    label: 'Delete a product that was never used',
    detail:
      'Remove a product entered by mistake. Refused once anything refers to it — deactivate it instead.',
  },
  {
    code: Permission.BRAND_MANAGE,
    group: 'Products',
    label: 'Manage brands',
    detail: 'Add, rename and remove brands.',
  },
  {
    code: Permission.CATEGORY_MANAGE,
    group: 'Products',
    label: 'Manage categories',
    detail: 'Add, rename and remove categories and their subcategories.',
  },
  {
    code: Permission.UNIT_MANAGE,
    group: 'Products',
    label: 'Manage units',
    detail:
      'Add, rename and remove units of measure — piece, carton, kilogram. Every conversion rule depends on these.',
  },
  {
    code: Permission.COST_VIEW,
    group: 'Products',
    label: 'See what goods cost',
    detail:
      'See purchase price and, later, cost and profit. Without this the cost is not sent to the screen at all.',
  },
  {
    code: Permission.INVENTORY_LOT_VIEW,
    group: 'Inventory',
    label: 'See stock lots and movement sources',
    detail: 'Open a product’s batches and trace each quantity back to its source transaction.',
  },
  {
    code: Permission.INVENTORY_COST_RECOMPUTE,
    group: 'Inventory',
    label: 'Recompute inventory costs',
    detail: 'Run the controlled costing repair after a permitted backdated or corrected stock transaction.',
  },
  {
    code: Permission.CUSTOMER_VIEW,
    group: 'Customers',
    label: 'See customers',
    detail: 'Open the Customers screen and look someone up.',
  },
  {
    code: Permission.CUSTOMER_CREATE,
    group: 'Customers',
    label: 'Add customers',
    detail: 'Save a new customer, at the counter or from the Customers screen.',
  },
  {
    code: Permission.CUSTOMER_EDIT,
    group: 'Customers',
    label: 'Edit customers',
    detail: 'Correct a customer’s details, including their credit limit.',
  },
  {
    code: Permission.CUSTOMER_DEACTIVATE,
    group: 'Customers',
    label: 'Deactivate and reactivate customers',
    detail: 'Stop a customer appearing in new sales. Their history and balance stay.',
  },
  {
    code: Permission.SUPPLIER_VIEW,
    group: 'Suppliers',
    label: 'See suppliers',
    detail: 'Open the Suppliers screen and look one up.',
  },
  {
    code: Permission.SUPPLIER_CREATE,
    group: 'Suppliers',
    label: 'Add suppliers',
    detail: 'Save a new supplier.',
  },
  {
    code: Permission.SUPPLIER_EDIT,
    group: 'Suppliers',
    label: 'Edit suppliers',
    detail: 'Correct a supplier’s details.',
  },
  {
    code: Permission.SUPPLIER_DEACTIVATE,
    group: 'Suppliers',
    label: 'Deactivate and reactivate suppliers',
    detail: 'Stop a supplier appearing in new purchases. Their history and balance stay.',
  },
  {
    code: Permission.VENDOR_VIEW,
    group: 'Vendors',
    label: 'See vendors',
    detail: 'Open the Vendors screen. Only available while vendors are switched on in Settings.',
  },
  {
    code: Permission.VENDOR_CREATE,
    group: 'Vendors',
    label: 'Add vendors',
    detail: 'Save a new vendor — someone whose goods you sell on their behalf.',
  },
  {
    code: Permission.VENDOR_EDIT,
    group: 'Vendors',
    label: 'Edit vendors',
    detail: 'Correct a vendor’s details.',
  },
  {
    code: Permission.VENDOR_DEACTIVATE,
    group: 'Vendors',
    label: 'Deactivate and reactivate vendors',
    detail: 'Stop a vendor appearing in new consignments. Their history and balance stay.',
  },
  {
    code: Permission.PARTY_GROUP_MANAGE,
    group: 'Customers',
    label: 'Manage customer groups',
    detail:
      'Add and rename the groups customers are sorted into. Only available while customer groups are switched on in Settings.',
  },
  {
    code: Permission.IMPORT_RUN,
    group: 'Import',
    label: 'Import a file of products or parties',
    detail:
      'Post a whole CSV file at once. Still needs permission to add the kind of record being imported.',
  },
  {
    code: Permission.PURCHASE_VIEW,
    group: 'Purchases',
    label: 'See purchases',
    detail: 'Open the purchase list and any bill, and see what is still owed on it.',
  },
  {
    code: Permission.PURCHASE_CREATE,
    group: 'Purchases',
    label: 'Record a purchase',
    detail:
      'Enter goods received from a supplier. This puts stock on the shelf and records what the supplier is owed.',
  },
  {
    code: Permission.PURCHASE_PAY,
    group: 'Purchases',
    label: 'Pay a supplier',
    detail: 'Hand money to a supplier from the drawer or a bank account and settle their bills.',
  },
  {
    code: Permission.SALE_VIEW,
    group: 'Sales',
    label: 'See sales and invoices',
    detail: 'Open the sales list and any invoice, and see what is still owed on it.',
  },
  {
    code: Permission.SALE_CREATE,
    group: 'Sales',
    label: 'Sell at the counter',
    detail:
      'Use the POS: take goods off the shelf, take the money, and give the customer an invoice.',
  },
  {
    code: Permission.SALE_EDIT,
    group: 'Sales',
    label: 'Correct a posted sale',
    detail:
      'Change what was actually sold — quantity, price, product or payment — on an invoice already posted. The correction is recorded, never hidden.',
  },
  {
    code: Permission.SALE_VOID,
    group: 'Sales',
    label: 'Cancel a sale',
    detail:
      'Reverse a whole invoice: the goods go back on the shelf and the money comes back out of the day.',
  },
  {
    code: Permission.SALE_RECEIVE_PAYMENT,
    group: 'Sales',
    label: 'Receive money from a customer',
    detail: 'Take money against what a customer owes and settle their invoices.',
  },
  {
    code: Permission.SALE_PRICE_EDIT,
    group: 'Sales',
    label: 'Change a price at the counter',
    detail: 'Sell an item at something other than its marked selling price.',
  },
  {
    code: Permission.SALE_DISCOUNT_APPLY,
    group: 'Sales',
    label: 'Give a discount',
    detail: 'Knock money off one line or off the whole bill.',
  },
  {
    code: Permission.SALE_PRESENTATION_EDIT,
    group: 'Sales',
    label: 'Edit how an invoice is printed',
    detail:
      'Change the names, addresses and notes printed on an invoice. It never changes quantity, price, payment, stock or accounts.',
  },
  {
    code: Permission.SALE_QUOTATION_MANAGE,
    group: 'Sales',
    label: 'Make quotations',
    detail: 'Prepare a price quotation for a customer. It reserves no stock and posts nothing.',
  },
  {
    code: Permission.SALE_ORDER_MANAGE,
    group: 'Sales',
    label: 'Take sales orders',
    detail: 'Record an order a customer placed, to be invoiced when the goods go out.',
  },
  {
    code: Permission.SALES_RETURN_VIEW,
    group: 'Sales',
    label: 'See customer returns',
    detail: 'Open the Sales Returns list and read what customers have brought back.',
  },
  {
    code: Permission.SALES_RETURN_CREATE,
    group: 'Sales',
    label: 'Take goods back from a customer',
    detail:
      'Accept a return against an invoice: the goods go back on the shelf and the value is refunded or left on the customer’s account. How much cash may be handed back is set on the role.',
  },
  {
    code: Permission.PURCHASE_RETURN_VIEW,
    group: 'Purchasing',
    label: 'See supplier returns',
    detail: 'Open the Purchase Returns list and read what went back to suppliers.',
  },
  {
    code: Permission.PURCHASE_RETURN_CREATE,
    group: 'Purchasing',
    label: 'Send goods back to a supplier',
    detail:
      'Return goods against a bill: stock leaves the shelf and the value comes back as money or as credit with the supplier.',
  },
  {
    code: Permission.PURCHASE_EDIT,
    group: 'Purchasing',
    label: 'Correct a posted bill',
    detail:
      'Fix a bill that was entered wrongly. The original is reversed and the corrected bill replaces it under the same number — refused once its goods have been sold.',
  },
  {
    code: Permission.PURCHASE_VOID,
    group: 'Purchasing',
    label: 'Cancel a bill',
    detail: 'Reverse a whole purchase: the goods come off the shelf and the supplier is no longer owed.',
  },
  {
    code: Permission.EXPENSE_VIEW,
    group: 'Money',
    label: 'See expenses',
    detail: 'Open the Expenses list and read what the shop has spent.',
  },
  {
    code: Permission.EXPENSE_RECORD,
    group: 'Money',
    label: 'Record an expense',
    detail: 'Enter rent, salary, electricity or any other cost, and the account it was paid from.',
  },
  {
    code: Permission.STOCK_COUNT_POST,
    group: 'Inventory',
    label: 'Post a stock count',
    detail:
      'Count the shelf against the system and post the difference — stock found is added, stock missing is written off.',
  },
  {
    code: Permission.PERIOD_CLOSE,
    group: 'Settings',
    label: 'Close a month',
    detail:
      'Close an accounting month so nothing more can post into it. A closed month is final; later corrections post in the open month.',
  },
  {
    code: Permission.PERIOD_BACKDATE,
    group: 'Settings',
    label: 'Enter an earlier date',
    detail:
      'Record a return, expense or count against a business date in the past, inside a month that is still open. A reason is required and the real entry time is kept.',
  },
  {
    code: Permission.CASH_ACCOUNT_VIEW,
    group: 'Money',
    label: 'See cash accounts and their balances',
    detail: 'Open the till, the safe and any other cash box, and see how much is in each.',
  },
  {
    code: Permission.CASH_ACCOUNT_MANAGE,
    group: 'Money',
    label: 'Set up cash accounts',
    detail:
      'Add a till or a safe, change its details and opening balance, or take one out of use once it is empty.',
  },
  {
    code: Permission.CASH_SESSION_START,
    group: 'Money',
    label: 'Start the day',
    detail: 'Count the cash going into the drawer and open the day so selling can begin.',
  },
  {
    code: Permission.CASH_SESSION_CLOSE,
    group: 'Money',
    label: 'Close the day',
    detail: 'Count the drawer at the end of the day and record what was actually in it.',
  },
  {
    code: Permission.CASH_SESSION_REOPEN,
    group: 'Money',
    label: 'Reopen a day closed by mistake',
    detail:
      'Undo today’s close and carry on trading. The mistaken count and its effect stay visible in the day’s history.',
  },
  {
    code: Permission.CASH_MOVEMENT_RECORD,
    group: 'Money',
    label: 'Move money between accounts',
    detail:
      'Record cash moved to the safe or the bank, and money the owner puts in or takes out.',
  },
  {
    code: Permission.CASH_DAILY_VIEW,
    group: 'Money',
    label: 'See the day’s cash position and history',
    detail: 'Open Daily Cash: what each day expected, what was counted and where they differed.',
  },
  {
    code: Permission.CASH_DAILY_INVESTIGATE,
    group: 'Money',
    label: 'Investigate a day that did not match',
    detail:
      'Open the day’s transactions from Daily Cash to find the difference. Correcting anything still needs that module’s own permission.',
  },
  {
    code: Permission.BANK_ACCOUNT_VIEW,
    group: 'Money',
    label: 'See bank and bKash accounts',
    detail: 'Open the shop’s bank, bKash and Nagad accounts and read their statements.',
  },
  {
    code: Permission.BANK_ACCOUNT_MANAGE,
    group: 'Money',
    label: 'Set up bank and bKash accounts',
    detail: 'Add a bank, bKash or Nagad account, change its details, or take one out of use.',
  },
];

/**
 * The roles every tenant is created with (§5.26). Shipped, then fully editable
 * by the owner once slice 1.4 exists.
 *
 * The permission lists are deliberately sparse: most of what these roles will
 * eventually hold — selling, stock, ledgers — has no permission code yet,
 * because the slices that create those codes have not been built. Each slice
 * adds its own codes to the roles that should hold them. Inventing the codes now
 * would mean granting names that nothing checks.
 */
/**
 * The expense categories every tenant starts with (owner decision 2026-08-26).
 *
 * A shopkeeper should never meet an empty dropdown on their first expense. The
 * code is half an account code — `EXPENSE:SALARY` — and is fixed for ever once
 * anything posts to it; the name beside it stays editable.
 */
export const SEED_EXPENSE_CATEGORIES: readonly { readonly code: string; readonly name: string }[] = [
  { code: 'SALARY', name: 'Salary' },
  { code: 'RENT', name: 'Rent' },
  { code: 'ELECTRICITY', name: 'Electricity' },
  { code: 'TRANSPORT', name: 'Transport' },
  { code: 'TEA_SNACKS', name: 'Tea & snacks' },
  { code: 'REPAIRS', name: 'Repairs' },
  { code: 'OTHER', name: 'Other' },
];

export interface SeedRole {
  readonly code: string;
  readonly name: string;
  readonly permissions: readonly Permission[];
  /**
   * How much cash this role may hand back on a return before a senior PIN is
   * needed (owner decision 2026-08-26). Absent means unlimited, which is what
   * every role but the Cashier ships with — the shop edits it on the Roles
   * screen the first time it disagrees.
   */
  readonly cashRefundPerReturnMinor?: number;
  readonly cashRefundPerDayMinor?: number;
}

export const SEED_ROLES: readonly SeedRole[] = [
  {
    code: 'OWNER',
    name: 'Owner',
    /*
     * "Everything including period unlock, settings, user management. Cannot be
     * deleted or de-privileged."
     *
     * Derived from the catalogue rather than listed, because `ManageRolesService`
     * already freezes the Owner role at every permission (slice 1.4). Two
     * hand-kept lists of "all of them" would drift the first time a module adds
     * a code, and the drift would show up as an owner who cannot use their own
     * new screen.
     */
    permissions: PERMISSION_CATALOGUE.map((entry) => entry.code),
  },
  {
    code: 'MANAGER',
    name: 'Manager',
    // "All operations, cost and profit visible; no settings/users." A manager
    // can see who works here, but cannot add or remove them — and runs the
    // catalog and the parties, cost included.
    permissions: [
      Permission.USER_VIEW,
      Permission.PRODUCT_VIEW,
      Permission.PRODUCT_CREATE,
      Permission.PRODUCT_EDIT,
      Permission.PRODUCT_DEACTIVATE,
      Permission.PRODUCT_DELETE,
      Permission.BRAND_MANAGE,
      Permission.CATEGORY_MANAGE,
      Permission.UNIT_MANAGE,
      Permission.COST_VIEW,
      Permission.INVENTORY_LOT_VIEW,
      Permission.INVENTORY_COST_RECOMPUTE,
      Permission.CUSTOMER_VIEW,
      Permission.CUSTOMER_CREATE,
      Permission.CUSTOMER_EDIT,
      Permission.CUSTOMER_DEACTIVATE,
      Permission.SUPPLIER_VIEW,
      Permission.SUPPLIER_CREATE,
      Permission.SUPPLIER_EDIT,
      Permission.SUPPLIER_DEACTIVATE,
      Permission.VENDOR_VIEW,
      Permission.VENDOR_CREATE,
      Permission.VENDOR_EDIT,
      Permission.VENDOR_DEACTIVATE,
      Permission.PARTY_GROUP_MANAGE,
      Permission.IMPORT_RUN,
      /*
       * "All operations" includes running the day and moving money — a manager
       * closes up when the cashier has gone home. Deliberately **not**
       * `*.account.manage`: opening a bank account is the shop's banking
       * arrangement, not an operation. Deliberately not `cash.session.reopen`
       * either (owner decision 2026-08-24) — a manager who did not perform the
       * close does not undo it; the manager who *did* close may still reopen
       * their own, through the rule the use case applies on top of the code.
       */
      Permission.CASH_ACCOUNT_VIEW,
      Permission.BANK_ACCOUNT_VIEW,
      Permission.CASH_SESSION_START,
      Permission.CASH_SESSION_CLOSE,
      Permission.CASH_MOVEMENT_RECORD,
      Permission.CASH_DAILY_VIEW,
      Permission.CASH_DAILY_INVESTIGATE,
      /*
       * Buying is operations, and cost is already visible to this role, so
       * the manager records deliveries and settles suppliers.
       */
      Permission.PURCHASE_VIEW,
      Permission.PURCHASE_CREATE,
      Permission.PURCHASE_PAY,
      /*
       * Selling is operations too, and this role already sees cost — so the
       * manager sells, prices, discounts, corrects and cancels, and takes
       * money against old dues. Quotations and orders come with it because
       * both are the wholesale half of the same counter.
       */
      Permission.SALE_VIEW,
      Permission.SALE_CREATE,
      Permission.SALE_EDIT,
      Permission.SALE_VOID,
      Permission.SALE_RECEIVE_PAYMENT,
      Permission.SALE_PRICE_EDIT,
      Permission.SALE_DISCOUNT_APPLY,
      Permission.SALE_PRESENTATION_EDIT,
      Permission.SALE_QUOTATION_MANAGE,
      Permission.SALE_ORDER_MANAGE,
      /*
       * Corrections are operations: the manager takes returns both ways, fixes
       * a bill that was typed wrongly, records what the shop spends and counts
       * the shelf. Deliberately **not** `period.close` — §5.26 keeps the
       * period out of this role, and a month is closed by the person who owns
       * the books, not the person who ran the day.
       */
      Permission.SALES_RETURN_VIEW,
      Permission.SALES_RETURN_CREATE,
      Permission.PURCHASE_RETURN_VIEW,
      Permission.PURCHASE_RETURN_CREATE,
      Permission.PURCHASE_EDIT,
      Permission.PURCHASE_VOID,
      Permission.EXPENSE_VIEW,
      Permission.EXPENSE_RECORD,
      Permission.STOCK_COUNT_POST,
      Permission.PERIOD_BACKDATE,
    ],
  },
  {
    code: 'CASHIER',
    name: 'Cashier',
    // ৳5,000 for one return and ৳10,000 across a day, as the shop's starting
    // point. Over either, the screen asks for an owner or manager PIN.
    cashRefundPerReturnMinor: 500_000,
    cashRefundPerDayMinor: 1_000_000,
    /*
     * "POS sell, receive payment, view the day's cash position. **No cost, no
     * profit, no purchase**."
     *
     * They must be able to find a product and save a customer at the counter —
     * §5.6 makes creating a customer mandatory the moment a sale leaves a due,
     * and a cashier who cannot do it cannot complete that sale. Deliberately
     * **not** `inventory.cost.view`: the purchase price never reaches the till.
     */
    permissions: [
      Permission.PRODUCT_VIEW,
      Permission.CUSTOMER_VIEW,
      Permission.CUSTOMER_CREATE,
      Permission.CUSTOMER_EDIT,
      /*
       * The day, and today's cash position — owner decision 2026-08-24. The
       * cashier opens the day, counts it and closes it, and can see what the
       * drawer holds, which is what §5.26 already promises them.
       *
       * Deliberately **not** `cash.movement.record`: moving money to the safe
       * or recording what the owner took is the act of deciding where cash
       * goes, and the person counting the drawer is not the person who should
       * also be able to explain a shortage by declaring a transfer. Not
       * `cash.session.reopen` either as a role grant — but a cashier who closed
       * by mistake can still undo their own close, because the use case admits
       * the person who performed it.
       */
      Permission.CASH_SESSION_START,
      Permission.CASH_SESSION_CLOSE,
      Permission.CASH_DAILY_VIEW,
      Permission.CASH_ACCOUNT_VIEW,
      /*
       * The counter itself: sell, take money against a due, and fix what an
       * invoice *says* before handing it over — a misspelt name or a missing
       * delivery address is caught at the counter or not at all.
       *
       * Deliberately **not** `sale.price.edit`, `sale.discount.apply`,
       * `sale.invoice.edit` or `sale.invoice.void`: changing a price, giving a
       * money-off, rewriting a posted sale or cancelling one are all decisions
       * about the shop's margin, and §5.26 puts them above this role. The POS
       * hides those controls rather than refusing them (UI-09).
       */
      Permission.SALE_VIEW,
      Permission.SALE_CREATE,
      Permission.SALE_RECEIVE_PAYMENT,
      Permission.SALE_PRESENTATION_EDIT,
      /*
       * A customer who brings goods back at eight in the evening is served by
       * whoever is at the counter, so the cashier takes returns — but how much
       * cash may leave the drawer for one is the role's refund limit, and over
       * it the screen asks for a senior PIN (owner decision 2026-08-26).
       * Deliberately **not** `period.backdate`: §5.26 excludes it by name.
       */
      Permission.SALES_RETURN_VIEW,
      Permission.SALES_RETURN_CREATE,
    ],
  },
  {
    code: 'STOREKEEPER',
    name: 'Storekeeper',
    /*
     * "Stock in/out, reconciliation, lots. **No pricing**, no financial
     * ledgers."
     *
     * They keep the catalog's vocabulary tidy — filing goods under the right
     * category, adding the unit a new line comes in — but do not create or edit
     * products, because both prices are mandatory product fields (§5.5) and
     * pricing is exactly what this role excludes.
     */
    permissions: [
      Permission.PRODUCT_VIEW,
      Permission.BRAND_MANAGE,
      Permission.CATEGORY_MANAGE,
      Permission.UNIT_MANAGE,
      Permission.INVENTORY_LOT_VIEW,
      Permission.SUPPLIER_VIEW,
      /*
       * They receive the goods, so they may read the bill behind a batch —
       * but not record one and not pay for it, because a purchase carries
       * both prices and this role excludes pricing. Without
       * `inventory.cost.view` the bill arrives with its amounts omitted
       * (UI-40), which is exactly the reading a storekeeper should get.
       */
      Permission.PURCHASE_VIEW,
      /*
       * "Stock in/out, reconciliation, lots" is this role in one line, so the
       * count sheet is theirs. They send goods back to a supplier as well —
       * that is the storeroom rejecting a delivery — and read the sales-return
       * list to know what has come back onto their shelves. No money: the
       * refund and the credit are somebody else's decision.
       */
      Permission.STOCK_COUNT_POST,
      Permission.PURCHASE_RETURN_VIEW,
      Permission.PURCHASE_RETURN_CREATE,
      Permission.SALES_RETURN_VIEW,
    ],
  },
  {
    code: 'ACCOUNTANT',
    name: 'Accountant',
    // "Ledgers, payments, expenses, bank, reports, period lock. No stock
    // movement, no selling." Cost is visible: a payables ledger and a profit
    // report are unreadable without it.
    permissions: [
      Permission.PRODUCT_VIEW,
      Permission.COST_VIEW,
      Permission.INVENTORY_LOT_VIEW,
      Permission.CUSTOMER_VIEW,
      Permission.SUPPLIER_VIEW,
      Permission.VENDOR_VIEW,
      /*
       * "Ledgers, payments, expenses, bank, reports." The accountant sets up
       * and reads the money accounts and investigates a day that did not
       * balance — but does not start or close the day, because they are not at
       * the counter and did not count the drawer.
       */
      Permission.CASH_ACCOUNT_VIEW,
      Permission.CASH_ACCOUNT_MANAGE,
      Permission.BANK_ACCOUNT_VIEW,
      Permission.BANK_ACCOUNT_MANAGE,
      Permission.CASH_MOVEMENT_RECORD,
      Permission.CASH_DAILY_VIEW,
      Permission.CASH_DAILY_INVESTIGATE,
      /* Payables are this role in one word: they enter the bills and pay them. */
      Permission.PURCHASE_VIEW,
      Permission.SALE_VIEW,
      Permission.SALE_RECEIVE_PAYMENT,
      Permission.PURCHASE_CREATE,
      Permission.PURCHASE_PAY,
      /*
       * "Expenses ... period lock" — §5.26 names both. The accountant records
       * what the shop spends, closes the month when the books are right, and
       * may date an entry back inside a month still open. Corrections to bills
       * are theirs too, because they are the ones who find the wrong figure.
       * No stock movement: the count belongs to the storekeeper.
       */
      Permission.EXPENSE_VIEW,
      Permission.EXPENSE_RECORD,
      Permission.PURCHASE_EDIT,
      Permission.PURCHASE_VOID,
      Permission.SALES_RETURN_VIEW,
      Permission.PURCHASE_RETURN_VIEW,
      Permission.PERIOD_CLOSE,
      Permission.PERIOD_BACKDATE,
    ],
  },
  {
    code: 'VIEWER',
    name: 'Viewer',
    // "Read-only, no cost, no profit." Money is read-only too: the balances and
    // the day's history, and nothing that starts, closes or moves anything.
    permissions: [
      Permission.PRODUCT_VIEW,
      Permission.INVENTORY_LOT_VIEW,
      Permission.CUSTOMER_VIEW,
      Permission.SUPPLIER_VIEW,
      Permission.CASH_ACCOUNT_VIEW,
      Permission.BANK_ACCOUNT_VIEW,
      Permission.CASH_DAILY_VIEW,
      Permission.PURCHASE_VIEW,
    ],
  },
];

export const OWNER_ROLE_CODE = 'OWNER';
