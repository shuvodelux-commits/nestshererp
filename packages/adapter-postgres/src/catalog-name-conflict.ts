import { AppError, ErrorCode } from '@sher/core-contracts';

/**
 * Active-master names are protected by migration 0007's partial unique indexes.
 * A read-then-insert/rename validation check cannot prevent a concurrent race:
 * the second writer loses at PostgreSQL, after both preflight reads may pass.
 *
 * Translate ONLY these exact PostgreSQL 23505 constraints, never arbitrary
 * integrity errors. Propagate every other error so schema, FK, RLS, connection
 * and programmer failures cannot masquerade as user-entered duplicate names.
 *
 * The repository caller must throw the mapped error out of its UoW: PostgreSQL
 * has already aborted the failed statement's transaction, so do not query,
 * retry, append audit or write outbox after this catch.
 */
export type CatalogNameKind = 'unit' | 'brand' | 'category';

const activeNameUniqueIndex: Record<CatalogNameKind, string> = {
  unit: 'units_tenant_name_unique',
  brand: 'brands_tenant_name_unique',
  category: 'categories_tenant_sibling_name_unique',
};

export function rethrowCatalogNameConflict(error: unknown, kind: CatalogNameKind): never {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === activeNameUniqueIndex[kind]
  ) {
    throw new AppError(ErrorCode.VALIDATION_FAILED, `Another ${kind} already uses that name`);
  }
  throw error;
}
