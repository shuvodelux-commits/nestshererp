/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers dialog:quick-add-select
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import QuickAddSelect from '../src/components/QuickAddSelect.vue';

/**
 * The unified PrimeVue picker (D-39, UI-45, UI-51): a searchable Select and a
 * separate gear action that opens the composed master-data workflow.
 *
 * Tested once here, so no page repeats it (R-E11). What matters:
 *
 *   Creating selects **the id the server returned** (UI-36), never a row matched
 *   by name — two names that normalise the same way would select the wrong one.
 */
const UNITS = [
  { id: '01UNITFEETAAAAAAAAAAAAAAAA', name: 'Feet' },
  { id: '01UNITPIPEAAAAAAAAAAAAAAAA', name: 'Pipe' },
];
const mountedWrappers: { unmount: () => void }[] = [];

function picker(overrides: Record<string, unknown> = {}) {
  const create = vi.fn().mockResolvedValue('01UNITNEWAAAAAAAAAAAAAAAAA');
  const rename = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue('Removed. Nothing was using it.');

  const host = document.createElement('div');
  document.body.append(host);
  const wrapper = mount(QuickAddSelect, {
    attachTo: host,
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
  mountedWrappers.push(wrapper);

  return { wrapper, create, rename, remove };
}

afterEach(() => {
  for (const wrapper of mountedWrappers.splice(0)) wrapper.unmount();
  document.body.replaceChildren();
});

describe('the picker itself', () => {
  it('uses the PrimeVue Select combobox with the field label wired to it', async () => {
    const { wrapper } = picker();

    expect(wrapper.find('.picker').exists()).toBe(true);
    const select = wrapper.find('[role="combobox"]');
    expect(select.attributes('id')).toBe('product-unit');
    expect(select.text()).toContain('Select unit…');

    await select.trigger('click');
    expect(wrapper.find('.picker [role="option"]').exists()).toBe(false);
    expect(
      [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].map(
        (option) => option.textContent,
      ),
    ).toEqual([
      'Feet',
      'Pipe',
    ]);
  });

  it('has one separate, labelled gear action and no duplicate New action', () => {
    const { wrapper } = picker();

    expect(wrapper.text()).not.toContain('New unit');
    const manage = wrapper.find('.picker-manage');
    expect(manage.attributes('aria-label')).toBe('Add or manage Unit');
    expect(manage.find('.pi-cog').exists()).toBe(true);
    expect(manage.text()).toBe('');
    expect(wrapper.findAll('.picker-manage')).toHaveLength(1);
  });

  it('reports what was chosen', async () => {
    const { wrapper } = picker();

    await wrapper.find('[role="combobox"]').trigger('click');
    const pipe = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === 'Pipe',
    );
    pipe?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

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
    expect(wrapper.find('[role="combobox"]').exists()).toBe(true);
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
