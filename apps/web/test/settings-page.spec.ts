/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:settings
 */
import { flushPromises, mount } from '@vue/test-utils';
import Select from 'primevue/select';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import { useSession } from '../src/auth/session';
import SettingsPage from '../src/pages/SettingsPage.vue';

/**
 * Slice 1.5 — the settings workflow smoke test (R-E11).
 *
 * What is worth asserting here is what the screen *promises*, not that Vue can
 * render a list: that a control the caller cannot use is absent rather than
 * disabled (UI-09), that a setting no module reads yet says so instead of
 * implying an effect, and that a step-up setting asks for the password before
 * sending anything.
 */
const load = vi.fn();
const save = vi.fn();
const saveProfile = vi.fn();

vi.mock('../src/api/settings', () => ({
  fetchSettings: (token: string) => load(token),
  saveSetting: (token: string, payload: unknown) => save(token, payload),
  saveBusinessProfile: (token: string, payload: unknown) => saveProfile(token, payload),
}));

vi.mock('../src/components/shell/AppShell.vue', () => ({
  default: {
    name: 'AppShell',
    template: '<div><div class="page-actions"><slot name="actions" /></div><slot /></div>',
  },
}));

const COSTING = {
  key: 'sale_costing_method',
  group: 'Costing',
  label: 'Cost of goods sold method',
  detail: 'How SherERP works out what a sale cost you.',
  kind: 'CHOICE' as const,
  options: ['FIFO', 'AVERAGE'],
  defaultValue: 'FIFO',
  requires: [],
  stepUp: true,
  consumedBy: 'Inventory & costing',
  inEffect: false,
};

const SERIAL = {
  key: 'serial_tracking_enabled',
  group: 'Stock',
  label: 'Track individual serial numbers',
  detail: 'Follow each unit separately by its serial number.',
  kind: 'TOGGLE' as const,
  options: ['on', 'off'],
  defaultValue: 'off',
  requires: [],
  stepUp: false,
  consumedBy: 'Serial & warranty',
  inEffect: false,
};

const WARRANTY = {
  key: 'warranty_enabled',
  group: 'Stock',
  label: 'Warranty',
  detail: 'Record and look up warranty on the units you sell.',
  kind: 'TOGGLE' as const,
  options: ['on', 'off'],
  defaultValue: 'off',
  requires: ['serial_tracking_enabled'],
  stepUp: false,
  consumedBy: 'Serial & warranty',
  inEffect: false,
};

function settingsBody(values: Record<string, string> = {}) {
  return {
    businessName: 'Karim Traders',
    timezone: 'Asia/Dhaka',
    supportedTimezones: ['Asia/Dhaka'],
    catalogue: [COSTING, SERIAL, WARRANTY],
    values: {
      sale_costing_method: 'FIFO',
      serial_tracking_enabled: 'off',
      warranty_enabled: 'off',
      ...values,
    },
  };
}

beforeEach(() => {
  const session = useSession();
  session.signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  // An owner. The read-only caller has its own suite below.
  session.setPermissions([
    'settings.setting.view',
    'settings.setting.edit',
    'settings.module.toggle',
  ]);
  load.mockReset();
  save.mockReset();
  saveProfile.mockReset();
  load.mockResolvedValue(settingsBody());
});

afterEach(() => {
  useSession().clear();
});

async function mountLoaded() {
  const wrapper = mount(SettingsPage);
  await flushPromises();
  return wrapper;
}

describe('SettingsPage', () => {
  it('shows a loading state until the settings arrive (UI-27)', () => {
    load.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(SettingsPage);

    expect(wrapper.find('[role="status"]').exists()).toBe(true);
  });

  it("shows the server's own code and message on failure (UI-28)", async () => {
    load.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'Permission required', 403));

    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('PERMISSION_DENIED');
    expect(wrapper.text()).toContain('Permission required');
    expect(wrapper.text()).not.toContain('Something went wrong');
  });

  it('lists settings by readable label, never by key', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('Cost of goods sold method');
    expect(wrapper.text()).toContain('Track individual serial numbers');
    expect(wrapper.text()).not.toContain('sale_costing_method');
  });

  it('says when a setting is stored but not yet obeyed by any module', async () => {
    const wrapper = await mountLoaded();

    // The honest marker: nothing reads this value until inventory ships.
    expect(wrapper.text()).toContain('Takes effect with Inventory & costing');
  });

  it('names the parent a dependent feature is waiting on (§5.21)', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('Needs Track individual serial numbers turned on first.');
  });

  it('saves a plain toggle without asking for a password', async () => {
    save.mockResolvedValue({
      settings: settingsBody({ serial_tracking_enabled: 'on' }),
      warnings: [],
    });

    const wrapper = await mountLoaded();
    const select = wrapper.findAllComponents(Select).find((item) => item.props('inputId') === 'setting-serial_tracking_enabled');
    select?.vm.$emit('update:modelValue', 'on');
    await flushPromises();

    expect(save).toHaveBeenCalledWith('test-access', {
      key: 'serial_tracking_enabled',
      value: 'on',
    });
    expect(wrapper.text()).toContain('Track individual serial numbers saved.');
  });

  it('displays the cascade the server reported (§5.21)', async () => {
    save.mockResolvedValue({
      settings: settingsBody(),
      warnings: [{ code: 'FEATURE_DISABLED', message: 'Warranty was turned off too.' }],
    });

    const wrapper = await mountLoaded();
    wrapper.findAllComponents(Select).find((item) => item.props('inputId') === 'setting-serial_tracking_enabled')?.vm.$emit('update:modelValue', 'on');
    await flushPromises();

    expect(wrapper.text()).toContain('Warranty was turned off too.');
  });

  it('asks for the password before sending a step-up change (§5.3)', async () => {
    const wrapper = await mountLoaded();

    wrapper.findAllComponents(Select).find((item) => item.props('inputId') === 'setting-sale_costing_method')?.vm.$emit('update:modelValue', 'AVERAGE');
    await flushPromises();

    // Nothing was sent yet — the password is collected first.
    expect(save).not.toHaveBeenCalled();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);

    save.mockResolvedValue({
      settings: settingsBody({ sale_costing_method: 'AVERAGE' }),
      warnings: [],
    });
    await wrapper.get('#step-up-password').setValue('Passw0rd23');
    await wrapper.get('[role="dialog"] form').trigger('submit');
    await flushPromises();

    expect(save).toHaveBeenCalledWith('test-access', {
      key: 'sale_costing_method',
      value: 'AVERAGE',
      confirmPassword: 'Passw0rd23',
    });
  });

  it('renames the business and updates the name the shell shows', async () => {
    saveProfile.mockResolvedValue({
      ...settingsBody(),
      businessName: 'Karim Electronics',
    });

    const wrapper = await mountLoaded();
    await wrapper.get('#business-name').setValue('Karim Electronics');
    await wrapper.get('.profile').trigger('submit');
    await flushPromises();

    expect(saveProfile).toHaveBeenCalledWith('test-access', {
      businessName: 'Karim Electronics',
      timezone: 'Asia/Dhaka',
    });
    // The sidebar reads this, so the rename is visible without signing in again.
    expect(useSession().businessName.value).toBe('Karim Electronics');
  });

  describe('a caller who may read but not change (UI-09)', () => {
    beforeEach(() => {
      useSession().setPermissions(['settings.setting.view']);
    });

    it('shows the values without rendering controls that would 403', async () => {
      const wrapper = await mountLoaded();

      expect(wrapper.text()).toContain('Cost of goods sold method');
      // Not a disabled select — absent. A disabled control still advertises
      // something they cannot do.
      expect(wrapper.find('#setting-sale_costing_method').exists()).toBe(false);
      expect(wrapper.find('#setting-serial_tracking_enabled').exists()).toBe(false);
      expect(wrapper.text()).toContain('You do not have permission to change these.');
    });
  });
});
