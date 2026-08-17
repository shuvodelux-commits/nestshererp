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
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

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
    // "Everything including period unlock, settings, user management. Cannot be
    // deleted or de-privileged."
    permissions: [
      Permission.USER_VIEW,
      Permission.USER_CREATE,
      Permission.USER_EDIT,
      Permission.USER_DISABLE,
    ],
  },
  // "All operations, cost and profit visible; no settings/users." A manager can
  // see who works here, but cannot add or remove them.
  { code: 'MANAGER', name: 'Manager', permissions: [Permission.USER_VIEW] },
  { code: 'CASHIER', name: 'Cashier', permissions: [] },
  { code: 'STOREKEEPER', name: 'Storekeeper', permissions: [] },
  { code: 'ACCOUNTANT', name: 'Accountant', permissions: [] },
  { code: 'VIEWER', name: 'Viewer', permissions: [] },
];

export const OWNER_ROLE_CODE = 'OWNER';
