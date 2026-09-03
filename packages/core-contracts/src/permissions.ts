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
   * Owner capital and loans (Finance module, owner decisions 2026-08-31).
   *
   * Three codes rather than reusing `cash.movement.record`, because moving the
   * day's takings to the bank and recording what the owner took home are
   * different sizes of trust. A cashier who can bank the cash should not
   * thereby be able to write down an owner withdrawal, and a bookkeeper
   * entering loan instalments should not thereby be able to open a new loan
   * account.
   *
   * `LOAN_ACCOUNT_MANAGE` also carries **seeing** loan accounts and their
   * balances: a loan is not one of the shop's money accounts, so
   * `cash.account.view` and `bank.account.view` never expose one.
   */
  OWNER_CAPITAL_RECORD: 'owner.capital.record',
  LOAN_MOVEMENT_RECORD: 'loan.movement.record',
  LOAN_ACCOUNT_MANAGE: 'loan.account.manage',

  /**
   * Reconciling an account against the bank's own statement (Phase 11, §5.17).
   *
   * Separate from `bank.account.view` because reading a statement and signing
   * off that it agrees with the bank are different acts: the second one is the
   * shop's control record, and `reopen` is separate again because reopening a
   * completed reconciliation reopens a period somebody already certified.
   */
  RECONCILIATION_VIEW: 'bank.reconciliation.view',
  RECONCILIATION_PERFORM: 'bank.reconciliation.perform',
  RECONCILIATION_REOPEN: 'bank.reconciliation.reopen',

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

  /**
   * Phase 8. Five codes, not twelve (owner simplification 2026-08-26).
   *
   * Entering a purchase's serial numbers and adding a landed cost to it are
   * deliberately **not** their own permissions: typing serials off the cartons
   * is part of recording the bill, and a cost that changes what a posted bill
   * came to is `purchase.bill.edit` by any honest reading. A permission per
   * keystroke is a permission nobody configures correctly.
   */
  PURCHASE_PLAN_VIEW: 'purchase.plan.view',
  PURCHASE_PLAN_MANAGE: 'purchase.plan.manage',
  WARRANTY_CLAIM_VIEW: 'warranty.claim.view',
  WARRANTY_CLAIM_MANAGE: 'warranty.claim.manage',
  VENDOR_STOCK_MANAGE: 'vendor.stock.manage',

  /**
   * Phase 8.3 — the Vendor Workspace (§5.6 M07, owner decision 2026-08-31).
   *
   * Three codes for three different risks rather than one `vendor.manage`.
   * Money **out** is the dangerous one: `VENDOR_PAYABLE` has no bill behind it
   * to check a payment against, so whoever may pay a vendor is not
   * automatically whoever may lend the shop's goods out. Money **in** is its
   * own code for the same reason it is on the customer side. Handing stock to
   * a vendor moves no money at all when it is a temporary issue, which is why
   * it is folded into neither.
   */
  VENDOR_PAYMENT_RECORD: 'vendor.payment.record',
  VENDOR_RECEIPT_RECORD: 'vendor.receipt.record',
  VENDOR_ISSUE_MANAGE: 'vendor.issue.manage',

  /**
   * Phase 9 — reports, dashboard and Daybook (§5.20, §5.27).
   *
   * One code per report screen rather than one `report.view` for all four
   * (owner decision 2026-08-30): §5.26's rule is that what a role may see is
   * decided per kind of figure, and a manager who runs the shop floor can be
   * given sales and stock without ever seeing what the shop owes or earns.
   *
   * `report.profit.view` is the §5.20 dashboard-profit gate and is separate
   * from `inventory.cost.view`, which withholds a *product's* cost. Profit is
   * the shop's, cost is a line's, and a shop may want one shown without the
   * other.
   *
   * Daybook's five are §5.27's own list, unchanged: it concentrates
   * visibility, never authority, so every action launched from it still needs
   * the source module's permission.
   */
  REPORT_SALES_VIEW: 'report.sales.view',
  REPORT_PURCHASE_VIEW: 'report.purchase.view',
  REPORT_STOCK_VIEW: 'report.stock.view',
  REPORT_MONEY_VIEW: 'report.money.view',
  REPORT_PROFIT_VIEW: 'report.profit.view',
  REPORT_TARGET_MANAGE: 'report.target.manage',
  DASHBOARD_VIEW: 'dashboard.card.view',
  DAYBOOK_VIEW: 'daybook.view',
  DAYBOOK_VIEW_ALL_USERS: 'daybook.view.all_users',
  DAYBOOK_VIEW_ENTRY_DATE: 'daybook.view.entry_date',
  DAYBOOK_REVIEW_MARK: 'daybook.review.mark',
  DAYBOOK_PRINT: 'daybook.print',

  /**
   * Phase 9.2 — cancelling what was already posted (owner decision
   * 2026-08-30).
   *
   * **Correcting rides on the code that recorded it** — a cashier who may take
   * money may fix the amount they just typed, and the before/after values are
   * in the audit trail either way. **Cancelling gets its own code per module**,
   * because §5.26 keeps destructive actions apart and undoing yesterday's
   * receipt is a different act from taking today's: it puts a customer back in
   * debt and takes money out of a drawer somebody has already counted.
   *
   * `sale.invoice.void` and `purchase.bill.void` already existed and are not
   * duplicated here.
   */
  RECEIPT_VOID: 'sale.receipt.void',
  SUPPLIER_PAYMENT_VOID: 'purchase.payment.void',
  EXPENSE_VOID: 'expense.void',
  CASH_MOVEMENT_VOID: 'cash.movement.void',
  STOCK_ADJUSTMENT_VOID: 'stock.adjustment.void',
  SALES_RETURN_VOID: 'sales.return.void',
  PURCHASE_RETURN_VOID: 'purchase.return.void',

  /**
   * Phase 10 — the licence, the backup, and the two operations that can empty
   * or replace the whole database (owner decisions 2026-08-30).
   *
   * **A `.sherdb` file plus its secret is the business.** Every price, cost,
   * customer balance and credential hash travels in one download, which is why
   * exporting is its own code rather than a corner of `settings.setting.view`,
   * and why export, restore and reset all three demand step-up as well: §5.3
   * classifies backup export and restore as sensitive actions needing a fresh
   * credential, and a session left open on the counter PC must not be enough to
   * walk out with the shop.
   *
   * Seeded to the **Owner alone**. Manager, Cashier, Storekeeper, Accountant
   * and Viewer receive none of them, so the Licence and Backup pages do not
   * render for those roles at all. A shop that wants its accountant to hold the
   * backup right grants it deliberately, and that grant is an audited act with
   * a date on it.
   *
   * `license.term.view` is permission-only: reading when the term ends is not a
   * dangerous act, and a licence nobody may look at is one nobody renews.
   */
  /**
   * Phase 11.2 — moving a posted voucher to the day it actually happened
   * (D-43, UI-70, owner decisions 2026-08-31).
   *
   * Its own code rather than a corner of the codes that record money, because
   * re-dating is not recording: it takes a figure out of one month's totals and
   * puts it into another's, after both have been read. Whoever enters an
   * expense every day is not automatically the person who decides which month
   * it belongs to — so this is seeded to Owner, Manager and Accountant, and
   * withheld from the Cashier who records most of them.
   *
   * `finance.transaction_date.change_locked` is the second half of the owner's
   * rule that **a closed period is protected, not immutable**. No seeded role
   * but the Owner holds it, and the Owner holds it only because that role is
   * the whole catalogue by construction. A shop that wants its accountant to
   * reach into a closed month grants it deliberately, and the grant is audited
   * — the same shape §5.3 gives the backup rights below.
   */
  TRANSACTION_DATE_CHANGE: 'finance.transaction_date.change',
  TRANSACTION_DATE_CHANGE_LOCKED: 'finance.transaction_date.change_locked',

  /**
   * Phase 12.1 — the offline foundation (§5.23, D-01, D-24, owner decisions
   * 2026-08-31).
   *
   * Five codes, because the five acts are five different sizes.
   *
   * `offline.device.register` is held by **every seeded role, the Cashier
   * included**, and that is deliberate rather than lax: registering creates
   * this browser's identity and lets it *ask*. It grants no offline authority
   * whatsoever, so the counter machine can put itself forward without the owner
   * having to sit at it — and a shop where only the owner's own browser could
   * ever register is a shop that never gets offline working at all.
   *
   * Approving, renaming and revoking are the shop deciding **which single
   * machine is its writer**, and sit with Owner and Manager. There is no
   * separate view code: the list is the approve screen, and seeing which
   * machine holds the shop's only offline authority is the same trust as
   * moving it.
   *
   * `offline.device.force_revoke` is the **Owner's alone**. A normal revoke
   * drains — the machine sends up what it holds and then goes read-only, losing
   * nothing. Force revoke cuts authority where the machine cannot drain, and
   * everything that device pushes afterwards is quarantined instead of posted.
   * It asks for the password again, demands a reason, and is audited
   * permanently. That is not a manager's decision to take alone.
   */
  DEVICE_REGISTER: 'offline.device.register',
  DEVICE_APPROVE: 'offline.device.approve',
  DEVICE_RENAME: 'offline.device.rename',
  DEVICE_REVOKE: 'offline.device.revoke',
  DEVICE_FORCE_REVOKE: 'offline.device.force_revoke',
  /*
   * Phase 12.4. Three codes rather than one `sync.manage`, split by what the
   * act costs when it is wrong. Seeing that six sales are still waiting costs
   * nothing. Retrying, merging and keeping-both hands a refused document back
   * to the server, which re-checks every rule anyway, so it can never post what
   * the counter could not have posted online — a manager's work. Deciding a
   * real sale will never be posted is the only one that leaves the shop's books
   * without a record of something that happened, and it is the Owner's alone.
   */
  SYNC_STATUS_VIEW: 'sync.status.view',
  SYNC_CONFLICT_RESOLVE: 'sync.conflict.resolve',
  SYNC_CONFLICT_DISCARD: 'sync.conflict.discard',
  LICENSE_VIEW: 'license.term.view',
  LICENSE_INSTALL: 'license.install',
  BACKUP_EXPORT: 'backup.export',
  BACKUP_RESTORE: 'backup.restore',
  BUSINESS_RESET: 'business.reset',
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
    code: Permission.PURCHASE_PLAN_VIEW,
    group: 'Purchasing',
    label: 'See the purchase planner',
    detail:
      'Open the planner and saved plans, and see what the shop is short of. Cost, profit and the budget stay hidden without "See cost and profit".',
  },
  {
    code: Permission.PURCHASE_PLAN_MANAGE,
    group: 'Purchasing',
    label: 'Make and send purchase plans',
    detail:
      'Save a plan, change its quantities, send a supplier their order, and close a plan that will never be finished. A plan changes no stock and no balance.',
  },
  {
    code: Permission.WARRANTY_CLAIM_VIEW,
    group: 'Warranty',
    label: 'See warranty claims',
    detail: 'Open the claim list and any claim, and look a serial number up.',
  },
  {
    code: Permission.WARRANTY_CLAIM_MANAGE,
    group: 'Warranty',
    label: 'Handle warranty claims',
    detail:
      'Take a faulty item in, send it to the supplier, replace it from own stock and settle the claim. Replacing from own stock charges the shop to warranty expense.',
  },
  {
    code: Permission.VENDOR_STOCK_MANAGE,
    group: 'Vendors',
    label: 'Receive and return vendor stock',
    detail:
      'Record goods a vendor left to be sold on their behalf, and hand back what did not sell. Neither moves money — the vendor is owed only when an item sells.',
  },
  {
    code: Permission.VENDOR_PAYMENT_RECORD,
    group: 'Vendors',
    label: 'Pay a vendor',
    detail:
      'Hand money to a vendor — either settling what selling their goods made the shop owe, or paying an advance before anything has sold.',
  },
  {
    code: Permission.VENDOR_RECEIPT_RECORD,
    group: 'Vendors',
    label: 'Take money from a vendor',
    detail:
      'Record money coming back from a vendor: settling what they owe for goods charged to them, or handing back an advance the shop had paid.',
  },
  {
    code: Permission.VENDOR_ISSUE_MANAGE,
    group: 'Vendors',
    label: 'Give products to a vendor and take them back',
    detail:
      'Send the shop’s own goods out to a vendor — charged to them as a sale, or on temporary issue where the goods are still the shop’s — and receive them back.',
  },
  {
    code: Permission.REPORT_SALES_VIEW,
    group: 'Reports',
    label: 'See sales reports',
    detail:
      'How much was sold over any period, and by which product, customer, staff member, brand, category or payment method.',
  },
  {
    code: Permission.REPORT_PURCHASE_VIEW,
    group: 'Reports',
    label: 'See purchase reports',
    detail: 'What the shop bought over any period, and from which supplier.',
  },
  {
    code: Permission.REPORT_STOCK_VIEW,
    group: 'Reports',
    label: 'See stock reports',
    detail:
      'What is on the shelf, what is running out, what is near expiry and how stock moved. Stock value and cost need "See cost and profit" as well.',
  },
  {
    code: Permission.REPORT_MONEY_VIEW,
    group: 'Reports',
    label: 'See money reports',
    detail:
      'Who owes the shop and for how long, what the shop owes its suppliers, cash and bank balances and what was spent.',
  },
  {
    code: Permission.REPORT_PROFIT_VIEW,
    group: 'Reports',
    label: 'See profit',
    detail:
      'The shop’s profit on the dashboard and in reports. Hidden while costing for the period is still provisional, so a half-costed profit is never shown as final.',
  },
  {
    code: Permission.REPORT_TARGET_MANAGE,
    group: 'Reports',
    label: 'Set the monthly target',
    detail:
      'Type the profit or sales target for a month. The projection beside it is an estimate from the current daily rate, never a posted figure.',
  },
  {
    code: Permission.DASHBOARD_VIEW,
    group: 'Reports',
    label: 'See the dashboard cards',
    detail:
      'Today’s sales, cash, bank, stock value, dues, payables and low stock on the home screen. Each card still needs its own report permission.',
  },
  {
    code: Permission.DAYBOOK_VIEW,
    group: 'Daybook',
    label: 'See the daybook',
    detail:
      'Everything that happened on a day — sales, purchases, money in and out, expenses, returns and stock changes — in one list, with the day’s cash summary.',
  },
  {
    code: Permission.DAYBOOK_VIEW_ALL_USERS,
    group: 'Daybook',
    label: 'See everybody’s entries',
    detail:
      'Without this, the daybook shows only what this user recorded themselves. A cashier checking their own counter does not need it.',
  },
  {
    code: Permission.DAYBOOK_VIEW_ENTRY_DATE,
    group: 'Daybook',
    label: 'See the daybook by entry time',
    detail:
      'Switch the daybook from the date a transaction belongs to, to the moment it was actually typed in. An audit view for finding late and backdated entries.',
  },
  {
    code: Permission.DAYBOOK_REVIEW_MARK,
    group: 'Daybook',
    label: 'Mark a day checked',
    detail: 'Tick a day off after tallying it against the notebook, with a note if something looked odd.',
  },
  {
    code: Permission.DAYBOOK_PRINT,
    group: 'Daybook',
    label: 'Print the day-end report',
    detail:
      'Print or reprint the day’s report on A4 or the counter roll. Every print is recorded, and a reprint is stamped as one.',
  },
  {
    code: Permission.RECEIPT_VOID,
    group: 'Sales',
    label: 'Cancel money received',
    detail:
      'Undo a receipt that was recorded by mistake. The customer owes the amount again and the money leaves the account it went into. A reason is required.',
  },
  {
    code: Permission.SUPPLIER_PAYMENT_VOID,
    group: 'Purchasing',
    label: 'Cancel a supplier payment',
    detail:
      'Undo money recorded as paid to a supplier. The bills it settled are owed again and the cash goes back. A reason is required.',
  },
  {
    code: Permission.EXPENSE_VOID,
    group: 'Money',
    label: 'Cancel an expense',
    detail: 'Undo an expense that was recorded by mistake, putting the money back where it came from. A reason is required.',
  },
  {
    code: Permission.CASH_MOVEMENT_VOID,
    group: 'Money',
    label: 'Cancel a cash movement',
    detail:
      'Undo a transfer, an owner withdrawal or a deposit that was recorded wrongly. A reason is required.',
  },
  {
    code: Permission.STOCK_ADJUSTMENT_VOID,
    group: 'Inventory',
    label: 'Cancel a stock adjustment',
    detail:
      'Undo a stock correction, putting the quantity and its value back. Refused once the stock it added has been sold. A reason is required.',
  },
  {
    code: Permission.SALES_RETURN_VOID,
    group: 'Sales',
    label: 'Cancel a customer return',
    detail:
      'Undo a return taken in by mistake: the goods leave the shelf again and the refund or credit is reversed. A reason is required.',
  },
  {
    code: Permission.PURCHASE_RETURN_VOID,
    group: 'Purchasing',
    label: 'Cancel a return to a supplier',
    detail: 'Undo goods recorded as sent back, putting them on the shelf and the credit back. A reason is required.',
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
  {
    code: Permission.OWNER_CAPITAL_RECORD,
    group: 'Money',
    label: 'Record money the owner puts in or takes out',
    detail:
      'Write down what the owner added to the business or took home. Cancelling one also needs “Cancel a money movement”.',
  },
  {
    code: Permission.LOAN_MOVEMENT_RECORD,
    group: 'Money',
    label: 'Record a loan received or repaid',
    detail:
      'Write down loan money received and instalments paid back. Cancelling one also needs “Cancel a money movement”.',
  },
  {
    code: Permission.LOAN_ACCOUNT_MANAGE,
    group: 'Money',
    label: 'See and set up loan accounts',
    detail:
      'Open the shop’s loans and what is still owed on each, add a new one, change its details or take one out of use.',
  },
  {
    code: Permission.TRANSACTION_DATE_CHANGE,
    group: 'Money',
    label: 'Change a transaction date',
    detail:
      'Move a receipt, payment, expense or cash movement to the day it really happened. The old posting is reversed and re-posted on the new day; the entry date never changes. A reason is required.',
  },
  {
    code: Permission.TRANSACTION_DATE_CHANGE_LOCKED,
    group: 'Money',
    label: 'Change a transaction date inside a closed month',
    detail:
      'Move a transaction into or out of a month that has been closed. Asks for the password again, demands a reason, and puts any reconciliation covering those days back under review.',
  },
  {
    code: Permission.RECONCILIATION_VIEW,
    group: 'Money',
    label: 'See account reconciliations',
    detail: 'Open a bank or bKash account’s reconciliation and read what was matched.',
  },
  {
    code: Permission.RECONCILIATION_PERFORM,
    group: 'Money',
    label: 'Reconcile an account against its statement',
    detail:
      'Upload a bank or bKash statement, match it against the shop’s own records and complete the reconciliation. Fixing a wrong transaction still needs that module’s own permission.',
  },
  {
    code: Permission.RECONCILIATION_REOPEN,
    group: 'Money',
    label: 'Reopen a completed reconciliation',
    detail: 'Undo a sign-off so an account can be reconciled again, or clear one marked for review.',
  },

  {
    code: Permission.DEVICE_REGISTER,
    group: 'Offline',
    label: 'Register this computer',
    detail:
      'Let the browser you are sitting at identify itself to the shop and ask for permission to work without internet. Asking is all it does — nothing can work offline until somebody approves it.',
  },
  {
    code: Permission.DEVICE_APPROVE,
    group: 'Offline',
    label: 'Approve the offline computer',
    detail:
      'See every computer that has registered, and choose the one that may work without internet. Only one computer in the shop holds it at a time.',
  },
  {
    code: Permission.DEVICE_RENAME,
    group: 'Offline',
    label: 'Rename a computer',
    detail: 'Give a registered computer a name the shop recognises, like “Counter PC — Chrome”.',
  },
  {
    code: Permission.DEVICE_REVOKE,
    group: 'Offline',
    label: 'Take offline permission back',
    detail:
      'Stop a computer working offline. It first sends up everything it is still holding, then goes read-only, so nothing is lost.',
  },
  {
    code: Permission.DEVICE_FORCE_REVOKE,
    group: 'Offline',
    label: 'Cut off a computer immediately',
    detail:
      'For a machine that is lost, stolen or dead: cut its permission at once, without waiting for it to send anything up. Anything it sends afterwards is held aside for review instead of going into the books. Asks for the password again and demands a reason.',
  },
  {
    code: Permission.SYNC_STATUS_VIEW,
    group: 'Offline',
    label: 'See what is waiting to be sent',
    detail:
      'Open the Sync screen: how many documents the offline computer is still holding, when it last got through, and anything the shop’s books would not accept.',
  },
  {
    code: Permission.SYNC_CONFLICT_RESOLVE,
    group: 'Offline',
    label: 'Sort out documents the books would not accept',
    detail:
      'Try a refused document again, merge it with what the shop already has, or keep both and edit. The server checks every rule again, so this cannot post anything the counter could not have posted online.',
  },
  {
    code: Permission.SYNC_CONFLICT_DISCARD,
    group: 'Offline',
    label: 'Decide a refused document will never be posted',
    detail:
      'Set a refused document aside so it never goes into the books, with a written reason. Nothing is erased — the original stays readable forever — but the shop’s record of that day will not contain it.',
  },
  {
    code: Permission.LICENSE_VIEW,
    group: 'Licence & backup',
    label: 'See the licence',
    detail: 'Open Settings → Licence and see when the term ends and what it includes.',
  },
  {
    code: Permission.LICENSE_INSTALL,
    group: 'Licence & backup',
    label: 'Install or renew the licence',
    detail:
      'Paste in the licence key the supplier sent and put it to work straight away. The key is checked first: one meant for another business, or one that ends sooner than the licence already here, is refused and nothing changes.',
  },
  {
    code: Permission.BACKUP_EXPORT,
    group: 'Licence & backup',
    label: 'Download a backup',
    detail:
      'Download the whole business as one encrypted file. Asks for the password again first.',
  },
  {
    code: Permission.BACKUP_RESTORE,
    group: 'Licence & backup',
    label: 'Restore a backup',
    detail:
      'Load a backup file into an empty installation. Asks for the password again first.',
  },
  {
    code: Permission.BUSINESS_RESET,
    group: 'Licence & backup',
    label: 'Reset business data',
    detail:
      'Empty this installation so a backup can be restored into it. Asks for the password again, and for the words to be typed out.',
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
  /*
   * Finance module, owner decision 2026-08-31: a loan instalment is recorded as
   * principal against the loan account plus the interest here, so the category
   * has to exist for the second half to have anywhere to go.
   */
  { code: 'LOAN_INTEREST', name: 'Loan interest' },
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
      // Reads a reconciliation, does not sign one off: agreeing with the bank
      // is the accountant's certificate, not an operation (§5.17).
      Permission.RECONCILIATION_VIEW,
      Permission.CASH_SESSION_START,
      Permission.CASH_SESSION_CLOSE,
      Permission.CASH_MOVEMENT_RECORD,
      Permission.LOAN_MOVEMENT_RECORD,
      Permission.LOAN_ACCOUNT_MANAGE,
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
      Permission.PURCHASE_PLAN_VIEW,
      Permission.PURCHASE_PLAN_MANAGE,
      Permission.WARRANTY_CLAIM_VIEW,
      Permission.WARRANTY_CLAIM_MANAGE,
      Permission.VENDOR_STOCK_MANAGE,
      /* Phase 8.3. The manager runs the vendor relationship end to end. */
      Permission.VENDOR_PAYMENT_RECORD,
      Permission.VENDOR_RECEIPT_RECORD,
      Permission.VENDOR_ISSUE_MANAGE,
      /*
       * Phase 9. The manager reads every report and the whole daybook,
       * including profit — §5.26 puts cost and profit inside this role — and
       * ticks a day off after checking it. The monthly target stays with the
       * owner: it is what the owner wants the shop to make, not a working
       * figure.
       */
      Permission.REPORT_SALES_VIEW,
      Permission.REPORT_PURCHASE_VIEW,
      Permission.REPORT_STOCK_VIEW,
      Permission.REPORT_MONEY_VIEW,
      Permission.REPORT_PROFIT_VIEW,
      Permission.DASHBOARD_VIEW,
      Permission.DAYBOOK_VIEW,
      Permission.DAYBOOK_VIEW_ALL_USERS,
      Permission.DAYBOOK_VIEW_ENTRY_DATE,
      Permission.DAYBOOK_REVIEW_MARK,
      Permission.DAYBOOK_PRINT,
      /*
       * Phase 9.2. The manager runs the floor and is who a cashier fetches when
       * something has to be undone, so every cancellation is theirs.
       */
      Permission.RECEIPT_VOID,
      Permission.SUPPLIER_PAYMENT_VOID,
      Permission.EXPENSE_VOID,
      Permission.CASH_MOVEMENT_VOID,
      Permission.STOCK_ADJUSTMENT_VOID,
      Permission.SALES_RETURN_VOID,
      Permission.PURCHASE_RETURN_VOID,
      /*
       * Phase 11.2. Re-dating is a floor correction — the manager is who a
       * cashier fetches when a voucher went in on the wrong day. Not the
       * `_locked` half: a closed month is the owner's to reopen.
       */
      Permission.TRANSACTION_DATE_CHANGE,
      /*
       * Phase 12.1. Which machine is the shop's offline computer is a floor
       * decision — the manager is who sets up a new counter PC. Not
       * `force_revoke`: cutting a machine off without letting it drain can
       * strand a day's takings, and that stays the owner's.
       */
      Permission.DEVICE_REGISTER,
      Permission.DEVICE_APPROVE,
      Permission.DEVICE_RENAME,
      Permission.DEVICE_REVOKE,
      /*
       * Phase 12.4. An outage ends with a queue to clear, and the manager is
       * who clears it — retry, merge, keep both. Not `discard`: deciding that
       * a sale the shop actually made will never enter the books is the one
       * sync act that loses a fact, and it stays the owner's.
       */
      Permission.SYNC_STATUS_VIEW,
      Permission.SYNC_CONFLICT_RESOLVE,
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
      Permission.WARRANTY_CLAIM_VIEW,
      /*
       * Phase 9. The cashier checks their own counter at the end of a shift:
       * the daybook without `daybook.view.all_users` shows only what they
       * recorded themselves (§5.27), and the day-end slip prints on the
       * counter roll. No reports, no dashboard, no profit.
       */
      Permission.DAYBOOK_VIEW,
      Permission.DAYBOOK_PRINT,
      /*
       * Phase 12.1. The counter machine is usually the one that will work
       * offline, and the cashier is who sits at it — so the cashier may put
       * this browser forward. It grants nothing: an owner or manager still has
       * to approve it before the machine can hold offline authority.
       */
      Permission.DEVICE_REGISTER,
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
      Permission.PURCHASE_PLAN_VIEW,
      Permission.WARRANTY_CLAIM_VIEW,
      Permission.VENDOR_STOCK_MANAGE,
      /* Phase 9. The shelf's own report, and nothing about money (§5.26). */
      Permission.REPORT_STOCK_VIEW,
      /* Phase 12.1. Registering asks; it never grants (see the code's note). */
      Permission.DEVICE_REGISTER,
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
      /*
       * "Ledgers, payments, expenses, bank" is the reconciler's own job, so
       * this role imports the statement and completes the sign-off. Reopening
       * a completed one stays with the Owner — undoing a certificate is not
       * the same act as making it.
       */
      Permission.RECONCILIATION_VIEW,
      Permission.RECONCILIATION_PERFORM,
      Permission.CASH_MOVEMENT_RECORD,
      Permission.CASH_DAILY_VIEW,
      Permission.CASH_DAILY_INVESTIGATE,
      /*
       * Phase 8.3. Paying a vendor and taking money back from one are payables
       * and receipts, which is this role. Lending the shop's goods out is not:
       * that moves stock, and this role does not move stock.
       */
      Permission.VENDOR_PAYMENT_RECORD,
      Permission.VENDOR_RECEIPT_RECORD,
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
      /*
       * Phase 11.2. Which month a payment belongs in is the question this role
       * exists to answer, so re-dating sits beside the period lock it respects.
       */
      Permission.TRANSACTION_DATE_CHANGE,
      Permission.PURCHASE_PLAN_VIEW,
      Permission.WARRANTY_CLAIM_VIEW,
      /*
       * Phase 9. Reports are named in this role's own description, and the
       * daybook by entry time is how a late entry is found — the accountant's
       * question, not the counter's. No dashboard target: see MANAGER.
       */
      Permission.REPORT_SALES_VIEW,
      Permission.REPORT_PURCHASE_VIEW,
      Permission.REPORT_STOCK_VIEW,
      Permission.REPORT_MONEY_VIEW,
      Permission.REPORT_PROFIT_VIEW,
      Permission.DASHBOARD_VIEW,
      Permission.DAYBOOK_VIEW,
      Permission.DAYBOOK_VIEW_ALL_USERS,
      Permission.DAYBOOK_VIEW_ENTRY_DATE,
      Permission.DAYBOOK_REVIEW_MARK,
      Permission.DAYBOOK_PRINT,
      /*
       * Phase 9.2. The accountant is the one who finds the wrong figure, so the
       * four money cancellations are theirs — stock is the storekeeper's shelf
       * and returns are taken at the counter.
       */
      Permission.RECEIPT_VOID,
      Permission.SUPPLIER_PAYMENT_VOID,
      Permission.EXPENSE_VOID,
      Permission.CASH_MOVEMENT_VOID,
      /* Phase 12.1. Registering asks; it never grants (see the code's note). */
      Permission.DEVICE_REGISTER,
      /*
       * Phase 12.4. Reading only. A day's takings that have not reached the
       * books yet is exactly the kind of gap an accountant is asked to explain,
       * so they can see the queue and the refusals — and resolve none of them,
       * because a refused document is put right at the counter it came from.
       */
      Permission.SYNC_STATUS_VIEW,
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
      Permission.RECONCILIATION_VIEW,
      Permission.CASH_DAILY_VIEW,
      Permission.PURCHASE_VIEW,
      Permission.PURCHASE_PLAN_VIEW,
      Permission.WARRANTY_CLAIM_VIEW,
      /*
       * Phase 12.1. Even a read-only account may register the browser it sits
       * at — a shop whose stocktaker's laptop is the spare counter machine
       * should not have to change somebody's role to find that out. Registering
       * grants no offline authority, and this role holds none of the codes that
       * would approve it.
       */
      Permission.DEVICE_REGISTER,
    ],
  },
];

export const OWNER_ROLE_CODE = 'OWNER';
