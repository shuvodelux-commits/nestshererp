import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import QuickAddSelect from '../src/components/QuickAddSelect.vue';

/**
 * The unified picker (D-39, UI-45, UI-51) — one control, three zones: the value,
 * a chevron that opens the list, and a grid button that opens the panel where
 * the list is added to and tidied.
 *
 * Tested once here, so no page repeats it (R-E11). What matters:
 *
 *   The element under the value is a **real `<select>`**. On Android that opens
 *   the system picker, which is a better list than anything drawn here and the
 *   one this audience already knows. Replacing it with a styled div would look
 *   the same on a laptop and be worse on every phone.
 *
 *   Creating selects **the id the server returned** (UI-36), never a row matched
 *   by name — two names that normalise the same way would select the wrong one.
 */
const UNITS = [
  { id: '01UNITFEETAAAAAAAAAAAAAAAA', name: 'Feet' },
  { id: '01UNITPIPEAAAAAAAAAAAAAAAA', name: 'Pipe' },
];

function picker(overrides: Record<string, unknown> = {}) {
  const create = vi.fn().mockResolvedValue('01UNITNEWAAAAAAAAAAAAAAAAA');
  const rename = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue('Removed. Nothing was using it.');

  const wrapper = mount(QuickAddSelect, {
    props: {
      modelValue: '',
      fieldId: 'product-unit',
      label: 'Unit',
      labelBn: 'একক',
      emptyLabel: 'Select unit…',
      options: UNITS,
      canAdd: true,
      canManage: true,
      create,
      rename,
      remove,
      ...overrides,
    },
  });

  return { wrapper, create, rename, remove };
}

describe('the picker itself', () => {
  it('is one control holding a real select', () => {
    const { wrapper } = picker();

    expect(wrapper.find('.picker').exists()).toBe(true);
    // A real <select>, so Android opens its own full-screen picker.
    expect(wrapper.find('select#product-unit').exists()).toBe(true);
    expect(wrapper.findAll('option').map((o) => o.text())).toEqual([
      'Select unit…',
      'Feet',
      'Pipe',
    ]);
  });

  it('has no separate New or Manage buttons beside it', () => {
    // Owner decision 2026-08-19: two extra buttons per field crushed the select
    // to nothing, and two buttons for "change this list" was two places to look.
    const { wrapper } = picker();

    expect(wrapper.text()).not.toContain('New unit');
    expect(wrapper.text()).not.toContain('Manage');
    expect(wrapper.findAll('.picker button').length).toBe(1);
  });

  it('reports what was chosen', async () => {
    const { wrapper } = picker();

    await wrapper.find('select').setValue('01UNITPIPEAAAAAAAAAAAAAAAA');

    expect(wrapper.emitted('update:modelValue')).toEqual([['01UNITPIPEAAAAAAAAAAAAAAAA']]);
  });
});

describe('the panel behind the grid button', () => {
  it('opens on the grid button and lists what is there', async () => {
    const { wrapper } = picker();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);

    await wrapper.find('.picker-manage').trigger('click');

    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).toContain('Feet');
    expect(dialog.text()).toContain('Pipe');
  });

  it('creates through the parent’s use case and selects what came back (UI-36)', async () => {
    const { wrapper, create } = picker();

    await wrapper.find('.picker-manage').trigger('click');
    await wrapper.find('.manage-add input').setValue('  Gaz  ');
    await wrapper.find('.manage-add button').trigger('click');
    await flushPromises();

    // Trimmed before sending — a trailing space is a typo, not a name.
    expect(create).toHaveBeenCalledWith('Gaz');
    // The server's id, not a row matched by name.
    expect(wrapper.emitted('update:modelValue')).toEqual([['01UNITNEWAAAAAAAAAAAAAAAAA']]);
  });

  it('offers no grid button when the caller can neither add nor manage (UI-09)', () => {
    // It would open a read-only list of things they cannot change.
    const { wrapper } = picker({ canAdd: false, canManage: false });

    expect(wrapper.find('.picker-manage').exists()).toBe(false);
    expect(wrapper.find('select').exists()).toBe(true);
  });

  it('still opens for a caller who may add but not manage', async () => {
    const { wrapper } = picker({ canManage: false });

    await wrapper.find('.picker-manage').trigger('click');

    expect(wrapper.find('.manage-add').exists()).toBe(true);
    // No row actions: they may add, not rename or delete.
    expect(wrapper.find('.manage-actions').exists()).toBe(false);
  });

  it('shows the server’s own refusal and keeps what was typed (UI-28)', async () => {
    const { wrapper, create } = picker();
    create.mockRejectedValue(new Error('That unit already exists'));

    await wrapper.find('.picker-manage').trigger('click');
    await wrapper.find('.manage-add input').setValue('Feet');
    await wrapper.find('.manage-add button').trigger('click');
    await flushPromises();

    expect(wrapper.find('.manage-error').text()).toContain('That unit already exists');
    // Not cleared — retyping a refused name is pure punishment.
    expect((wrapper.find('.manage-add input').element as HTMLInputElement).value).toBe('Feet');
  });
});
