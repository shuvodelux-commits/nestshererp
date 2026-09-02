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
  /**
   * Take a number a device has already printed out of circulation (Phase 12.4).
   *
   * An offline sale is numbered on the machine that made it, on paper the
   * customer walks out with, so replay must post it under **that** number and
   * never a fresh one (§8: synchronization never renumbers a sale). This moves
   * the device's own counter past the number it used, so the server can never
   * later hand the same number to a second document.
   *
   * Idempotent: reserving a number already behind the counter changes nothing,
   * which is what a repeated push must cost.
   */
  reserve(
    tx: Tx,
    ctx: TenantContext,
    docType: string,
    year: number,
    deviceCode: string,
    sequence: number,
  ): Promise<void>;
}
