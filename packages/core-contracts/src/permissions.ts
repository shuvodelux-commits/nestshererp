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
export interface SeedRole {
  readonly code: string;
  readonly name: string;
  readonly permissions: readonly Permission[];
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
    ],
  },
  {
    code: 'CASHIER',
    name: 'Cashier',
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
    ],
  },
  {
    code: 'VIEWER',
    name: 'Viewer',
    // "Read-only, no cost, no profit."
    permissions: [
      Permission.PRODUCT_VIEW,
      Permission.INVENTORY_LOT_VIEW,
      Permission.CUSTOMER_VIEW,
      Permission.SUPPLIER_VIEW,
    ],
  },
];

export const OWNER_ROLE_CODE = 'OWNER';
