/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:roles
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import { useSession } from '../src/auth/session';
import RolesPage from '../src/pages/RolesPage.vue';

/**
 * UI-44: renders, shows loading, shows error. Whether the Owner role may be
 * reduced is decided by the server; this screen only declines to offer it.
 */
const list = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();

vi.mock('../src/api/roles', () => ({
  fetchRoles: (token: string) => list(token),
  createRole: (token: string, payload: unknown) => create(token, payload),
  updateRole: (token: string, id: string, payload: unknown) => update(token, id, payload),
  deleteRole: (token: string, id: string, password: string) => remove(token, id, password),
}));

vi.mock('../src/components/shell/AppShell.vue', () => ({
  // The real shell renders a page header whose `actions` slot holds the screen's
  // primary button, so the stand-in must render that slot too.
  default: {
    name: 'AppShell',
    template: '<div><div class="page-actions"><slot name="actions" /></div><slot /></div>',
  },
}));

const CATALOGUE = [
  {
    code: 'user.account.view',
    group: 'People',
    label: 'See the user list',
    detail: 'Open the Users screen.',
  },
  {
    code: 'user.role.manage',
    group: 'Roles',
    label: 'Change what roles may do',
    detail: 'Create roles and change their permissions.',
  },
];

const OWNER_ROLE = {
  id: '01ROLEOWNERAAAAAAAAAAAAAAA',
  code: 'OWNER',
  name: 'Owner',
  isSystem: true,
  locked: true,
  permissions: ['user.account.view', 'user.role.manage'],
  userCount: 1,
};

const CASHIER_ROLE = {
  id: '01ROLECASHIERAAAAAAAAAAAAA',
  code: 'CASHIER',
  name: 'Cashier',
  isSystem: true,
  locked: false,
  permissions: [],
  userCount: 0,
};

const CUSTOM_ROLE = {
  id: '01ROLECUSTOMAAAAAAAAAAAAAA',
  code: 'SHIFT_SUPERVISOR',
  name: 'Shift Supervisor',
  isSystem: false,
  locked: false,
  permissions: ['user.account.view'],
  userCount: 0,
};

beforeEach(() => {
  const session = useSession();
  session.signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  // An owner, so the controls are offered. The hidden case has its own suite.
  session.setPermissions(['user.role.view', 'user.role.manage']);
  list.mockReset();
  create.mockReset();
  update.mockReset();
  remove.mockReset();
  list.mockResolvedValue({
    roles: [OWNER_ROLE, CASHIER_ROLE, CUSTOM_ROLE],
    catalogue: CATALOGUE,
  });
});

afterEach(() => {
  useSession().clear();
});

async function mountLoaded() {
  const wrapper = mount(RolesPage);
  await flushPromises();
  return wrapper;
}

describe('RolesPage', () => {
  it('shows a skeleton until the roles arrive (UI-27)', () => {
    list.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(RolesPage);

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
  });

  it('lists each role with readable permission names, not codes', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('Owner');
    expect(wrapper.text()).toContain('Cashier');
    expect(wrapper.text()).toContain('See the user list');
    expect(wrapper.text()).not.toContain('user.account.view');
    // A role with nothing ticked says so rather than showing an empty gap.
    expect(wrapper.text()).toContain('Cannot do anything yet');
  });

  it("shows the server's own code and message on failure (UI-28)", async () => {
    list.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'Permission required', 403));

    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('PERMISSION_DENIED');
    expect(wrapper.text()).toContain('Permission required');
    expect(wrapper.text()).not.toContain('Something went wrong');
  });

  it('will not offer tick-boxes for the Owner role (§5.26)', async () => {
    const wrapper = await mountLoaded();

    // Owner is the first card; its action reads "Rename", not "Edit".
    const ownerCard = wrapper.findAll('.role')[0]!;
    expect(ownerCard.findAll('.linkish')[0]!.text()).toBe('Rename');
    await ownerCard.findAll('.linkish')[0]!.trigger('click');

    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('always keeps every permission');
  });

  it('offers no Delete on a role that ships with SherERP', async () => {
    const wrapper = await mountLoaded();

    const cashierCard = wrapper.findAll('.role')[1]!;
    expect(cashierCard.text()).not.toContain('Delete');

    const customCard = wrapper.findAll('.role')[2]!;
    expect(customCard.text()).toContain('Delete');
  });

  it('asks for your password before saving a change', async () => {
    update.mockResolvedValue({ ...CASHIER_ROLE, permissions: ['user.account.view'] });
    const wrapper = await mountLoaded();

    await wrapper.findAll('.role')[1]!.findAll('.linkish')[0]!.trigger('click');
    // Saving is blocked until the password is given.
    expect(
      wrapper.find('[role="dialog"] button[type="submit"]').attributes('disabled'),
    ).toBeDefined();

    await wrapper.find('input[type="checkbox"]').setValue(true);
    await wrapper.find('#role-confirm').setValue('Passw0rd23');
    await wrapper.find('[role="dialog"] form').trigger('submit');
    await flushPromises();

    expect(update).toHaveBeenCalledWith('test-access', CASHIER_ROLE.id, {
      name: 'Cashier',
      permissions: ['user.account.view'],
      confirmPassword: 'Passw0rd23',
    });
    expect(wrapper.text()).toContain('affected straight away');
  });

  it('creates a role with the ticks chosen', async () => {
    create.mockResolvedValue(CUSTOM_ROLE);
    const wrapper = await mountLoaded();

    await wrapper.find('.page-actions button').trigger('click');
    await wrapper.find('#role-name').setValue('Shift Supervisor');
    await wrapper.find('input[type="checkbox"]').setValue(true);
    await wrapper.find('#role-confirm').setValue('Passw0rd23');
    await wrapper.find('[role="dialog"] form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledWith('test-access', {
      name: 'Shift Supervisor',
      permissions: ['user.account.view'],
      // Phase 7: a new role starts with no refund limit — unlimited — and the
      // form carries the pair so an edit cannot silently drop what a role holds.
      cashRefundPerReturnMinor: null,
      cashRefundPerDayMinor: null,
      confirmPassword: 'Passw0rd23',
    });
  });
});

/**
 * UI-09: "Never render a control that will 403." A Manager may read this screen
 * — they hold `user.role.view` — but not change it. Offering buttons that refuse
 * them, and then explaining the refusal, is what the rule exists to prevent.
 */
describe('RolesPage for someone who may look but not change', () => {
  beforeEach(() => {
    useSession().setPermissions(['user.role.view']);
  });

  it('still shows the roles and what each may do', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('Owner');
    expect(wrapper.text()).toContain('See the user list');
  });

  it('offers no Add, no Edit and no Delete', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.find('.page-actions button').exists()).toBe(false);
    expect(wrapper.findAll('.linkish')).toHaveLength(0);
    expect(wrapper.text()).not.toContain('Add role');
  });

  it('says why, instead of leaving the absence unexplained', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('not change it');
    expect(wrapper.text()).toContain('Ask the business owner');
  });
});
