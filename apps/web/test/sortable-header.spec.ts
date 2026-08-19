import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import SortableHeader from '../src/components/SortableHeader.vue';

/**
 * UI-46's shared header. Tested once here, so no list page repeats these
 * assertions (R-E11) — every list uses this component, so it is either right
 * everywhere or wrong everywhere.
 */
function header(props: Record<string, unknown> = {}) {
  return mount(SortableHeader, {
    props: {
      column: 'name',
      active: 'name',
      direction: 'ASC',
      label: 'Product',
      ...props,
    },
  });
}

describe('a sortable column header', () => {
  it('asks for its own column when tapped', () => {
    const wrapper = header({ column: 'minStockQty', active: 'name' });

    void wrapper.find('button').trigger('click');

    expect(wrapper.emitted('sort')).toEqual([['minStockQty']]);
  });

  it('shows an arrow only on the column the list is actually sorted by', () => {
    const sorted = header({ column: 'name', active: 'name' });
    const other = header({ column: 'sellingPrice', active: 'name' });

    expect(sorted.find('.sort-arrow').classes()).not.toContain('is-hidden');
    // Hidden rather than removed: the space is kept so tapping between columns
    // does not shuffle every header sideways.
    expect(other.find('.sort-arrow').classes()).toContain('is-hidden');
    expect(other.find('.sort-arrow').exists()).toBe(true);
  });

  it('points the arrow the way the result reads', () => {
    expect(header({ direction: 'ASC' }).find('.sort-arrow').classes()).toContain('pi-arrow-up');
    expect(header({ direction: 'DESC' }).find('.sort-arrow').classes()).toContain('pi-arrow-down');
  });

  it('tells a screen reader what the arrow shows', () => {
    // The arrow is invisible to a screen reader; `aria-sort` is how the same
    // fact reaches someone who cannot see it.
    expect(header({ direction: 'ASC' }).find('th').attributes('aria-sort')).toBe('ascending');
    expect(header({ direction: 'DESC' }).find('th').attributes('aria-sort')).toBe('descending');
    expect(header({ active: 'other' }).find('th').attributes('aria-sort')).toBe('none');
  });

  it('carries Bangla helper text beside the English label (UI-16)', () => {
    const wrapper = header({ label: 'Reorder at', labelBn: 'যত কমে গেলে আবার আনতে হবে' });

    expect(wrapper.text()).toContain('Reorder at');
    expect(wrapper.find('.sher-bn').text()).toBe('যত কমে গেলে আবার আনতে হবে');
  });

  it('makes the whole header the tap target, not a small icon', () => {
    // A thumb-sized target is the difference between sorting the list and
    // mis-tapping the row beneath it.
    const button = header().find('button');

    expect(button.exists()).toBe(true);
    expect(button.classes()).toContain('sort-button');
  });
});
