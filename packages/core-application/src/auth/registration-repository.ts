import type { IdentifierChannel } from '@sher/core-domain';

import type { TenantContext } from '../ports/tenant-context';
import type { Tx } from '../ports/unit-of-work';

/**
 * The rows a signup creates, and the pre-authentication lookup it needs.
 *
 * Business-specific interfaces, no generic CRUD (R-B7). Implementations live in
 * adapter-postgres and expose no Drizzle type, which is what keeps a SQLite WASM
 * implementation possible (D-14).
 *
 * `tenant_id` still never comes from a request payload (R-C4). It is generated
 * by the use case, because this is the one operation in the system that creates
 * the tenant rather than acting inside one.
 */

export interface NewTenant {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
}

export interface NewRole {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface NewUser {
  readonly id: string;
  readonly roleId: string;
  readonly username: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly passwordHash: string;
  readonly pinHash: string;
}

export interface TenantRepository {
  insert(tx: Tx, ctx: TenantContext, tenant: NewTenant): Promise<void>;
  findName(tx: Tx, ctx: TenantContext): Promise<string | null>;
}

export interface RoleRepository {
  insertSystemRole(tx: Tx, ctx: TenantContext, role: NewRole): Promise<void>;
}

export interface UserRepository {
  insert(tx: Tx, ctx: TenantContext, user: NewUser): Promise<void>;
}

/**
 * The pre-authentication index from an identifier to the account that owns it.
 *
 * It exists because `users` is RLS-scoped and a signup has no tenant context to
 * search it with — and because "one phone or email, one account" has to be
 * enforced by a unique constraint, not by a read-then-write race. Slice 1.2's
 * login resolves its identifier through this same index.
 *
 * It is never exposed through an API: knowing an identifier is taken is exactly
 * what an enumeration attack wants, so callers answer with a generic conflict.
 */
export interface UserIdentifierRepository {
  isTaken(tx: Tx, identifier: string): Promise<boolean>;
  claim(
    tx: Tx,
    entry: {
      readonly id: string;
      readonly identifier: string;
      readonly channel: IdentifierChannel;
      readonly tenantId: string;
      readonly userId: string;
    },
  ): Promise<void>;
}
