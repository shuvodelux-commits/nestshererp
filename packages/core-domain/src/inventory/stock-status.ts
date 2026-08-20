import { Qty } from '@sher/shared-utils';

export type StockStatus = 'IN_STOCK' | 'LOW_STOCK' | 'ZERO_STOCK' | 'NEGATIVE_STOCK';

/** Product activation and physical stock are deliberately independent (G2.3). */
export function stockStatus(qtyOnHand: number, minimumQty: number): StockStatus {
  const onHand = Qty(qtyOnHand);
  const minimum = Qty(minimumQty);
  if (minimum.raw < 0) throw new RangeError('Minimum stock cannot be negative');
  if (onHand.raw < 0) return 'NEGATIVE_STOCK';
  if (onHand.raw === 0) return 'ZERO_STOCK';
  if (onHand.compare(minimum) <= 0) return 'LOW_STOCK';
  return 'IN_STOCK';
}
