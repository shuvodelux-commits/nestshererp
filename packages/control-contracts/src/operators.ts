import { z } from 'zod';

/**
 * Who may do what in the vendor console (§23).
 *
 * **The separations here are the point, not the roles.** A support engineer who
 * can reach the licence signer can mint themselves a perpetual licence for any
 * shop; a licence operator who can deploy can ship a build nobody reviewed; a
 * release operator who can open a support session can touch a customer's books
 * on their own authority. Each of those is one careless permission grant away,
 * and each is prevented below by the permission simply not being in the set.
 *
 * All five are enforced from the first day even though there is one operator
 * today (owner decision 2026-09-03). Retrofitting a boundary into audited code
 * later, under pressure, at the moment a first hire needs access, is how
 * boundaries end up not existing.
 */
export const operatorRoleSchema = z.enum([
  'PLATFORM_OWNER',
  'SUPPORT_ENGINEER',
  'RELEASE_OPERATOR',
  'LICENCE_OPERATOR',
  'AUDITOR',
]);
export type OperatorRole = z.infer<typeof operatorRoleSchema>;

/**
 * Every capability the console gates on.
 *
 * Named as `noun.verb` like the ERP's own permission codes, so an operator
 * reading an audit row does not have to learn a second vocabulary.
 */
export const OPERATOR_PERMISSIONS = [
  'tenant.view',
  'tenant.manage',
  'installation.view',
  'installation.enrol',
  'installation.revoke',
  'licence.view',
  'licence.issue',
  'licence.revoke',
  'release.view',
  'release.publish',
  'deployment.view',
  'deployment.run',
  'issue.view',
  'issue.manage',
  'diagnostics.view',
  'support.view',
  'support.open',
  'support.revoke',
  'flags.manage',
  'audit.view',
  'operator.manage',
] as const;
export type OperatorPermission = (typeof OPERATOR_PERMISSIONS)[number];

/**
 * The grants, written out rather than derived.
 *
 * A table you can read top to bottom and check against §23 by eye is worth more
 * here than a clever inheritance scheme whose effective grants you have to run
 * to discover.
 */
export const ROLE_PERMISSIONS: Readonly<Record<OperatorRole, readonly OperatorPermission[]>> = {
  /** Everything. The account that can sign, deploy and enter a shop. */
  PLATFORM_OWNER: [...OPERATOR_PERMISSIONS],

  /**
   * Diagnose and fix a customer's problem — and nothing that changes what the
   * customer is entitled to or what code they run.
   */
  SUPPORT_ENGINEER: [
    'tenant.view',
    'installation.view',
    'licence.view',
    'release.view',
    'deployment.view',
    'issue.view',
    'diagnostics.view',
    'support.view',
    'support.open',
    'support.revoke',
    'audit.view',
  ],

  /**
   * Ship builds. Explicitly **not** granted `support.open` — §23's example, and
   * the reason is that deploying a fix and correcting a shop's accounts are
   * different authorities that happen to be needed by the same bug.
   */
  RELEASE_OPERATOR: [
    'tenant.view',
    'installation.view',
    'release.view',
    'release.publish',
    'deployment.view',
    'deployment.run',
    'issue.view',
    'issue.manage',
    'diagnostics.view',
    'audit.view',
  ],

  /**
   * Issue and revoke licences. No `deployment.run`, no `support.open`: selling
   * a customer another year is not the same authority as changing their
   * software or their books.
   */
  LICENCE_OPERATOR: [
    'tenant.view',
    'tenant.manage',
    'installation.view',
    'licence.view',
    'licence.issue',
    'licence.revoke',
    'audit.view',
  ],

  /** Read everything, change nothing. For review, and for after an incident. */
  AUDITOR: [
    'tenant.view',
    'installation.view',
    'licence.view',
    'release.view',
    'deployment.view',
    'issue.view',
    'diagnostics.view',
    'support.view',
    'audit.view',
  ],
};

/**
 * Actions that demand a fresh TOTP code and a written reason (§24).
 *
 * Being logged in is not the same as being present. Each of these either
 * reaches into a customer's installation or changes what they may run, and a
 * stolen session cookie should not be enough to do any of them.
 */
export const REAUTH_ACTIONS: readonly string[] = [
  'licence.issue',
  'licence.revoke',
  'installation.revoke',
  'deployment.run',
  'support.open',
  'flags.manage',
  'operator.manage',
];

export function permissionsOf(role: OperatorRole): readonly OperatorPermission[] {
  return ROLE_PERMISSIONS[role];
}

export function roleHas(role: OperatorRole, permission: OperatorPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
