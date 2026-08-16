import type { TenantContext } from './tenant-context';
import type { Tx } from './unit-of-work';

/**
 * Document numbering (D-30, SRS 3.7): `{PREFIX}-{YYYY}-{NNNNNN}`.
 *
 * Allocated inside the document's own transaction from a counter row held with
 * SELECT ... FOR UPDATE, so concurrent writers cannot produce a duplicate.
 * Voided numbers are never reused — a gap is normal and auditable.
 */
export interface NumberingService {
  allocate(tx: Tx, ctx: TenantContext, docType: string, year: number): Promise<string>;
}
