import { addDays, monthOf, weekdayOf } from '@sher/shared-utils';

/**
 * The date range every report opens with (owner decision 2026-08-30).
 *
 * Preset buttons plus Custom, with **This Month** selected — a shopkeeper
 * should never have to pick two dates for the range they ask for every day.
 * The presets live here rather than in each page so all four screens offer the
 * same words in the same order; learning one teaches the rest.
 */
export type RangePreset = 'TODAY' | 'YESTERDAY' | 'THIS_WEEK' | 'THIS_MONTH' | 'LAST_MONTH' | 'CUSTOM';

export interface DateRange {
  readonly from: string;
  readonly to: string;
}

export const RANGE_PRESETS: readonly { value: RangePreset; label: string; labelBn: string }[] = [
  { value: 'TODAY', label: 'Today', labelBn: 'আজ' },
  { value: 'YESTERDAY', label: 'Yesterday', labelBn: 'গতকাল' },
  { value: 'THIS_WEEK', label: 'This week', labelBn: 'এই সপ্তাহ' },
  { value: 'THIS_MONTH', label: 'This month', labelBn: 'এই মাস' },
  { value: 'LAST_MONTH', label: 'Last month', labelBn: 'গত মাস' },
  { value: 'CUSTOM', label: 'Custom', labelBn: 'নিজে বাছুন' },
];

/** The last day of the month a business date belongs to. */
function endOfMonth(businessDate: string): string {
  const [year = '', month = ''] = monthOf(businessDate).split('-');
  const next = month === '12' ? `${Number(year) + 1}-01-01` : `${year}-${String(Number(month) + 1).padStart(2, '0')}-01`;
  return addDays(next, -1);
}

/**
 * A preset turned into two dates, against the day the shop is having.
 *
 * `today` is passed in rather than read from the browser clock: the tenant's
 * business date is the server's answer (§3.5), and a phone left on the wrong
 * timezone must not silently shift what "today" means on a report.
 */
export function rangeFor(preset: RangePreset, today: string): DateRange {
  switch (preset) {
    case 'TODAY':
      return { from: today, to: today };
    case 'YESTERDAY': {
      const day = addDays(today, -1);
      return { from: day, to: day };
    }
    case 'THIS_WEEK': {
      // The shop's week starts on Saturday, as it does in Bangladesh.
      const sinceSaturday = (weekdayOf(today) + 1) % 7;
      return { from: addDays(today, -sinceSaturday), to: today };
    }
    case 'LAST_MONTH': {
      const firstOfThis = `${monthOf(today)}-01`;
      const lastMonthEnd = addDays(firstOfThis, -1);
      return { from: `${monthOf(lastMonthEnd)}-01`, to: lastMonthEnd };
    }
    case 'THIS_MONTH':
    default:
      return { from: `${monthOf(today)}-01`, to: endOfMonth(today) };
  }
}
