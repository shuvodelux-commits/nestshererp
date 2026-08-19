import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import QuickAddSelect from '../src/components/QuickAddSelect.vue';

/**
 * D-39 / UI-45 — quick add from the point of use. A shared state component, so
 * R-E11 asks for its own test rather than repeating these assertions on every
 * page that uses it.
 *
 * What matters here:
 *
 *   The new record is selected only after the **server** returns its id — no
 *   optimistic row this component invented (UI-36).
 *
 *   A refusal shows the server's own code and message and leaves the field open
 *   so the name can be corrected, rather than throwing the typing away (UI-28).
 *
 *   Without the create permission the button is **absent**, not disabled
 *   (UI-09).
 */
const OPTIONS = [
  { id: '01UNITPIECEAAAAAAAAAAAAAAA', name: 'Piece' },
  { id: '01UNITCARTONAAAAAAAAAAAAAA', name: 'Carton' },
];

function mountSelect(overrides: Record<string, unknown> = {}) {
  return mount(QuickAddSelect, {
    props: {
      modelValue: OPTIONS[0]!.id,
      fieldId: 'product-unit',
      label: 'Base unit',
      options: OPTIONS,
      canAdd: true,
      addLabel: 'New unit',
      create: vi.fn(),
      ...overrides,
    },
  });
}

describe('QuickAddSelect', () => {
  it('shows the options and the labelled select (UI-42)', () => {
    const wrapper = mountSelect();

    expect(wrapper.find('label').attributes('for')).toBe('product-unit');
    expect(wrapper.findAll('option').map((option) => option.text())).toEqual(['Piece', 'Carton']);
  });

  it('selects what the server created, not a row it invented (UI-36)', async () => {
    const create = vi.fn().mockResolvedValue('01UNITGAZAAAAAAAAAAAAAAAAA');
    const wrapper = mountSelect({ create });

    await wrapper.find('.add').trigger('click');
    await wrapper.find('.adder input').setValue('Gaz');
    await wrapper.find('.adder .btn-primary').trigger('click');
    await flushPromises();

    expect(create).toHaveBeenCalledWith('Gaz');
    expect(wrapper.emitted('update:modelValue')).toEqual([['01UNITGAZAAAAAAAAAAAAAAAAA']]);
    // The inline field closes once it has done its job.
    expect(wrapper.find('.adder').exists()).toBe(false);
  });

  it('trims the name before sending it', async () => {
    const create = vi.fn().mockResolvedValue('01UNITGAZAAAAAAAAAAAAAAAAA');
    const wrapper = mountSelect({ create });

    await wrapper.find('.add').trigger('click');
    await wrapper.find('.adder input').setValue('  Gaz  ');
    await wrapper.find('.adder .btn-primary').trigger('click');
    await flushPromises();

    expect(create).toHaveBeenCalledWith('Gaz');
  });

  it("keeps the typing and shows the server's refusal (UI-28)", async () => {
    const create = vi
      .fn()
      .mockRejectedValue(new ApiError('VALIDATION_FAILED', 'There is already a unit called Gaz', 400));
    const wrapper = mountSelect({ create });

    await wrapper.find('.add').trigger('click');
    await wrapper.find('.adder input').setValue('Gaz');
    await wrapper.find('.adder .btn-primary').trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('There is already a unit called Gaz');
    expect(wrapper.text()).toContain('VALIDATION_FAILED');
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    // Still open, still holding what was typed — the name only needs correcting.
    expect((wrapper.find('.adder input').element as HTMLInputElement).value).toBe('Gaz');
  });

  it('cannot be submitted twice while in flight (UI-35)', async () => {
    const create = vi.fn().mockReturnValue(new Promise(() => undefined));
    const wrapper = mountSelect({ create });

    await wrapper.find('.add').trigger('click');
    await wrapper.find('.adder input').setValue('Gaz');
    await wrapper.find('.adder .btn-primary').trigger('click');
    await flushPromises();

    expect(wrapper.find('.adder .btn-primary').attributes('disabled')).toBeDefined();
    await wrapper.find('.adder .btn-primary').trigger('click');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('is absent, not disabled, without the create permission (UI-09)', () => {
    const wrapper = mountSelect({ canAdd: false });

    expect(wrapper.find('.add').exists()).toBe(false);
  });

  it('abandons the inline field on cancel without creating anything', async () => {
    const create = vi.fn();
    const wrapper = mountSelect({ create });

    await wrapper.find('.add').trigger('click');
    await wrapper.find('.adder input').setValue('Gaz');
    await wrapper.findAll('.adder .btn-ghost')[0]!.trigger('click');

    expect(wrapper.find('.adder').exists()).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});
