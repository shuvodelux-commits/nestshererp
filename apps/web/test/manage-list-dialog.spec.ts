/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers dialog:manage-list
 */
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';

import ManageListDialog from '../src/components/ManageListDialog.vue';

/**
 * UI-51's Manage panel. Tested once here, so no picker repeats it (R-E11).
 *
 * The case that matters most is the last: §3.6 says a name products already use
 * is **archived**, not deleted, and the caller has to be told which happened. A
 * panel that always said "deleted" would be lying about the one thing a
 * shopkeeper needs to know before they tap it.
 */
function panel(overrides: Record<string, unknown> = {}) {
  const create = vi.fn().mockResolvedValue('01CATNEWAAAAAAAAAAAAAAAAAA');
  const rename = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue('Removed. Nothing was using it.');

  const wrapper = mount(ManageListDialog, {
    props: {
      title: 'categories',
      titleBn: 'পণ্যের ধরন',
      entries: [
        { id: '01CATAAAAAAAAAAAAAAAAAAAAA', name: 'Drinks' },
        { id: '01CATBBBBBBBBBBBBBBBBBBBBB', name: 'Fittings' },
      ],
      canEdit: true,
      canAdd: true,
      create,
      rename,
      remove,
      ...overrides,
    },
  });

  return { wrapper, create, rename, remove };
}

/** Opens the `⋯` menu on the first row. */
async function openRowMenu(wrapper: ReturnType<typeof panel>['wrapper']) {
  await wrapper.findAll('.manage-actions button')[0]!.trigger('click');
}

describe('managing a picker’s list in place', () => {
  it('lists every entry with its own actions', async () => {
    const { wrapper } = panel();

    expect(wrapper.text()).toContain('Drinks');
    expect(wrapper.text()).toContain('Fittings');
    expect(wrapper.findAll('.manage-actions').length).toBe(2);

    await openRowMenu(wrapper);
    expect(wrapper.find('.manage-menu').text()).toContain('Edit');
    expect(wrapper.find('.manage-menu').text()).toContain('Delete');
  });

  it('renames through the same use case the settings screen calls', async () => {
    const { wrapper, rename } = panel();

    await openRowMenu(wrapper);
    await wrapper.findAll('.manage-menu .p-menu-item-content')[0]!.trigger('click');
    await wrapper.find('.manage-input').setValue('Cold drinks');
    await wrapper.find('.manage-save').trigger('click');
    await flushPromises();

    expect(rename).toHaveBeenCalledWith('01CATAAAAAAAAAAAAAAAAAAAAA', 'Cold drinks');
  });

  it('asks before removing, and names the record (UI-26)', async () => {
    const { wrapper, remove } = panel();

    await openRowMenu(wrapper);
    await wrapper.findAll('.manage-menu .p-menu-item-content')[1]!.trigger('click');

    // Not removed yet — the confirmation is a real step, not a formality.
    expect(remove).not.toHaveBeenCalled();
    expect(wrapper.find('.manage-confirm').text()).toContain('Drinks');
  });

  it('says archived when the server archived, not deleted', async () => {
    // §3.6: a category products already use is archived so those products keep
    // showing it. Claiming "deleted" here would be a lie about their data.
    const { wrapper, remove } = panel();
    remove.mockResolvedValue('It is still used by some products, so it was archived.');

    await openRowMenu(wrapper);
    await wrapper.findAll('.manage-menu .p-menu-item-content')[1]!.trigger('click');
    await wrapper.find('.manage-remove').trigger('click');
    await flushPromises();

    expect(wrapper.find('.manage-outcome').text()).toContain('archived');
  });

  it('offers no row actions at all without the permission (UI-09)', () => {
    // A menu whose every item 403s is worse than no menu.
    const { wrapper } = panel({ canEdit: false });

    expect(wrapper.findAll('.manage-actions').length).toBe(0);
    expect(wrapper.text()).toContain('Drinks');
  });

  it('says what an empty list means and where the add button is', () => {
    const { wrapper } = panel({ entries: [] });

    expect(wrapper.find('.manage-empty').text()).toContain('Nothing here yet');
  });
});

/**
 * The row actions used to open as a floating menu positioned over a panel with
 * `overflow-y: auto`, so the panel clipped them: Edit and Delete landed below
 * its edge and choosing one meant scrolling. Reported from the running app.
 */
describe('reaching Edit and Delete without scrolling', () => {
  it('opens the actions inside the row, not as a floating menu', async () => {
    const { wrapper } = panel();

    await openRowMenu(wrapper);
    const menu = wrapper.find('.manage-menu');

    expect(menu.exists()).toBe(true);
    // Inside the row itself — a positioned menu is what a scrollable ancestor
    // clips, so being a child of the `li` is the property that matters.
    expect(menu.element.closest('li')).not.toBeNull();
    expect(menu.text()).toContain('Edit');
    expect(menu.text()).toContain('Delete');
  });

  it('labels the ⋯ button for anyone who has not met that icon', async () => {
    const { wrapper } = panel();
    const trigger = wrapper.findAll('.manage-actions button')[0]!;

    expect(trigger.attributes('aria-label')).toBe('Actions for Drinks');

    // PrimeVue Tooltip enhances pointer/focus use; the accessible name remains
    // present without hover for touch and assistive technology.
    expect(trigger.attributes('title')).toBeUndefined();
  });
});
