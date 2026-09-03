/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers dialog:date-only-picker
 */
import { mount } from '@vue/test-utils';
import DatePicker from 'primevue/datepicker';
import { describe, expect, it } from 'vitest';

import DateOnlyPicker from '../src/components/DateOnlyPicker.vue';

describe('DateOnlyPicker', () => {
  it('gives PrimeVue a local calendar date without parsing the value as UTC', () => {
    const wrapper = mount(DateOnlyPicker, { props: { inputId: 'business-date', modelValue: '2026-08-20' } });
    const value = wrapper.findComponent(DatePicker).props('modelValue') as Date;
    expect([value.getFullYear(), value.getMonth() + 1, value.getDate()]).toEqual([2026, 8, 20]);
  });

  it('emits the canonical date-only value selected in PrimeVue', () => {
    const wrapper = mount(DateOnlyPicker, { props: { inputId: 'business-date', modelValue: '2026-08-21' } });
    const selected = wrapper.findComponent(DatePicker).props('modelValue') as Date;
    wrapper.findComponent(DatePicker).vm.$emit('update:modelValue', selected);
    expect(wrapper.emitted('update:modelValue')).toEqual([['2026-08-21']]);
  });

  it('clears the canonical value when the PrimeVue picker is cleared', () => {
    const wrapper = mount(DateOnlyPicker, { props: { inputId: 'business-date', modelValue: '2026-08-20' } });
    wrapper.findComponent(DatePicker).vm.$emit('update:modelValue', null);
    expect(wrapper.emitted('update:modelValue')).toEqual([['']]);
  });
});
