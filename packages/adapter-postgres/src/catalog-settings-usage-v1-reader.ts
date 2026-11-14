import type { TenantContext, Tx } from '@sher/core-application';
import { sql } from 'drizzle-orm';

import { txOf } from './unit-of-work';

/** MOD-002 P7b1. Unmounted, read-only single-MVCC-snapshot tenant census.
 * Caller is responsible for current signed permissions and must use UoW.
 * No endpoint or new schema. Counts reference distinct *nondeleted products*,
 * including inactive; a master archived via deleted_at still has references.
 */
export interface CatalogSettingsUsageReadV1 {
  readonly units: readonly { readonly id: string; readonly productCount: number }[];
  readonly brands: readonly { readonly id: string; readonly productCount: number }[];
  readonly categories: readonly {
    readonly id: string;
    readonly directProductCount: number;
    readonly subtreeProductCount: number;
    readonly parentState: 'root' | 'present' | 'unresolved';
  }[];
  readonly unresolved: {
    readonly unitIds: readonly string[];
    readonly brandIds: readonly string[];
    readonly categoryIds: readonly string[];
    readonly parentIds: readonly string[];
  };
}
interface Row {
  readonly kind: string;
  readonly id: unknown;
  readonly direct_count: unknown;
  readonly subtree_count: unknown;
  readonly parent_id: unknown;
}
function safeCount(raw: unknown): number {
  const result = typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^(0|[1-9][0-9]*)$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid catalog usage count');
  return result;
}
export class PostgresCatalogSettingsUsageV1Reader {
  async read(tx: Tx, ctx: TenantContext): Promise<CatalogSettingsUsageReadV1> {
    // Every table is tenant-filtered explicitly AND FORCE RLS protected.
    // UNION rather than additive counts deduplicates base, legacy conversion,
    // and product_unit_conversions for a given (product, unit) pair.
    const query = await txOf(tx).execute(sql`
      WITH live_products AS (
        SELECT id, base_unit_id, conversion_unit_id, brand_id, category_id
          FROM products WHERE tenant_id = ${ctx.tenantId} AND deleted_at IS NULL
      ),
      own_units AS (SELECT id FROM units WHERE tenant_id = ${ctx.tenantId}),
      own_brands AS (SELECT id FROM brands WHERE tenant_id = ${ctx.tenantId}),
      own_categories AS (SELECT id,parent_id FROM categories WHERE tenant_id = ${ctx.tenantId}),
      unit_references AS (
        SELECT id product_id, base_unit_id unit_id FROM live_products
        UNION
        SELECT id, conversion_unit_id FROM live_products WHERE conversion_unit_id IS NOT NULL
        UNION
        SELECT edge.product_id,edge.unit_id FROM product_unit_conversions edge
          INNER JOIN live_products p ON p.id = edge.product_id
         WHERE edge.tenant_id = ${ctx.tenantId} AND edge.deleted_at IS NULL
      ),
      unit_counts AS (
        SELECT unit_id id, count(*)::bigint total FROM unit_references GROUP BY unit_id
      ),
      brand_counts AS (
        SELECT brand_id id, count(DISTINCT id)::bigint total FROM live_products
         WHERE brand_id IS NOT NULL GROUP BY brand_id
      ),
      category_direct AS (
        SELECT category_id id, count(DISTINCT id)::bigint total FROM live_products
         WHERE category_id IS NOT NULL GROUP BY category_id
      ),
      category_references AS (
        SELECT id product_id, category_id FROM live_products WHERE category_id IS NOT NULL
        UNION
        SELECT p.id, c.parent_id FROM live_products p
          INNER JOIN own_categories c ON c.id=p.category_id
         WHERE c.parent_id IS NOT NULL
      ),
      category_subtree AS (
        SELECT category_id id, count(DISTINCT product_id)::bigint total
          FROM category_references GROUP BY category_id
      ),
      census AS (
        SELECT 'unit'::text kind,u.id::text id,coalesce(uc.total,0)::bigint direct_count,
               NULL::bigint subtree_count,NULL::text parent_id
          FROM own_units u LEFT JOIN unit_counts uc ON uc.id=u.id
        UNION ALL
        SELECT 'brand',b.id::text,coalesce(bc.total,0)::bigint,NULL::bigint,NULL::text
          FROM own_brands b LEFT JOIN brand_counts bc ON bc.id=b.id
        UNION ALL
        SELECT 'category',c.id::text,coalesce(cd.total,0)::bigint,
               coalesce(cs.total,0)::bigint,c.parent_id::text
          FROM own_categories c LEFT JOIN category_direct cd ON cd.id=c.id
          LEFT JOIN category_subtree cs ON cs.id=c.id
        UNION ALL
        SELECT 'missing_unit',uc.id::text,0::bigint,NULL::bigint,NULL::text
          FROM unit_counts uc LEFT JOIN own_units u ON u.id=uc.id WHERE u.id IS NULL
        UNION ALL
        SELECT 'missing_brand',bc.id::text,0::bigint,NULL::bigint,NULL::text
          FROM brand_counts bc LEFT JOIN own_brands b ON b.id=bc.id WHERE b.id IS NULL
        UNION ALL
        SELECT 'missing_category',cd.id::text,0::bigint,NULL::bigint,NULL::text
          FROM category_direct cd LEFT JOIN own_categories c ON c.id=cd.id WHERE c.id IS NULL
        UNION ALL
        SELECT DISTINCT 'missing_parent',c.parent_id::text,0::bigint,NULL::bigint,NULL::text
          FROM own_categories c LEFT JOIN own_categories parent ON parent.id=c.parent_id
         WHERE c.parent_id IS NOT NULL AND parent.id IS NULL
        UNION ALL
        SELECT DISTINCT 'invalid_hierarchy',child.id::text,0::bigint,NULL::bigint,NULL::text
          FROM own_categories child
          INNER JOIN own_categories parent ON parent.id=child.parent_id
         WHERE parent.parent_id IS NOT NULL OR child.id=parent.id
      )
      SELECT kind,id,direct_count,subtree_count,parent_id FROM census ORDER BY kind,id
    `);
    const units: { id: string; productCount: number }[] = [];
    const brands: { id: string; productCount: number }[] = [];
    const categories: {
      id: string; parentId: string | null; directProductCount: number; subtreeProductCount: number;
    }[] = [];
    const unresolved = {
      unitIds: [] as string[], brandIds: [] as string[],
      categoryIds: [] as string[], parentIds: [] as string[],
    };
    for (const raw of query.rows) {
      const row = raw as Row;
      if (typeof row.id !== 'string' || row.id.length !== 26) {
        throw new Error('Invalid catalog usage reference ID');
      }
      if (row.kind === 'invalid_hierarchy') throw new Error('Invalid catalog category hierarchy');
      switch (row.kind) {
        case 'unit':
          units.push({ id: row.id, productCount: safeCount(row.direct_count) });
          break;
        case 'brand':
          brands.push({ id: row.id, productCount: safeCount(row.direct_count) });
          break;
        case 'category':
          if (row.parent_id !== null &&
              (typeof row.parent_id !== 'string' || row.parent_id.length !== 26)) {
            throw new Error('Invalid category parent ID');
          }
          categories.push({
            id: row.id, parentId: row.parent_id,
            directProductCount: safeCount(row.direct_count),
            subtreeProductCount: safeCount(row.subtree_count),
          });
          break;
        case 'missing_unit': unresolved.unitIds.push(row.id); break;
        case 'missing_brand': unresolved.brandIds.push(row.id); break;
        case 'missing_category': unresolved.categoryIds.push(row.id); break;
        case 'missing_parent': unresolved.parentIds.push(row.id); break;
        default: throw new Error('Invalid catalog usage row type');
      }
    }
    const ids = new Set(categories.map(c => c.id));
    return {
      units, brands,
      categories: categories.map(c => ({
        id: c.id,
        directProductCount: c.directProductCount,
        subtreeProductCount: c.subtreeProductCount,
        parentState: c.parentId === null ? 'root' as const
          : ids.has(c.parentId) ? 'present' as const : 'unresolved' as const,
      })),
      unresolved,
    };
  }
}
