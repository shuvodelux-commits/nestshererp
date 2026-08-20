import { Qty, UnitCost } from '@sher/shared-utils';

import { fixedAccount } from '../accounting/account';
import { rejectEntry } from '../accounting/journal-entry';
import type { JournalEntryDraft } from '../accounting/journal-entry';
import { stockValueMinor } from './costing';

export interface OpeningStockPosting {
  readonly qty: number;
  readonly unitCost: number;
  readonly valueMinor: number;
  readonly journal: JournalEntryDraft;
}

/** Builds the one physical and financial meaning of an owned opening lot. */
export function openingStockPosting(qty: number, unitCost: number): OpeningStockPosting {
  const checkedQty = Qty(qty);
  const checkedCost = UnitCost(unitCost);
  if (checkedQty.raw <= 0) throw new RangeError('Opening stock quantity must be greater than zero');
  if (checkedCost.raw < 0) throw new RangeError('Opening stock unit cost cannot be negative');

  const valueMinor = stockValueMinor(checkedQty.raw, checkedCost.raw);
  if (valueMinor <= 0) throw new RangeError('Opening stock value must be at least one poisha');

  const journal: JournalEntryDraft = {
    lines: [
      { account: fixedAccount('INVENTORY'), amountMinor: valueMinor, partyId: null },
      { account: fixedAccount('OPENING_EQUITY'), amountMinor: -valueMinor, partyId: null },
    ],
  };
  if (rejectEntry(journal) !== null) throw new Error('Opening stock journal is not balanced');
  return { qty: checkedQty.raw, unitCost: checkedCost.raw, valueMinor, journal };
}
