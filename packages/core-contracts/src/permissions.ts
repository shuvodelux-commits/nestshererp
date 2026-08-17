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
    // "Everything including period unlock, settings, user management. Cannot be
    // deleted or de-privileged."
    permissions: [
      Permission.USER_VIEW,
      Permission.USER_CREATE,
      Permission.USER_EDIT,
      Permission.USER_DISABLE,
      Permission.ROLE_VIEW,
      Permission.ROLE_MANAGE,
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
