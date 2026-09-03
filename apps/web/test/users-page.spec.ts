/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:users
 */
import { flushPromises, mount } from '@vue/test-utils';
import Select from 'primevue/select';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import { useSession } from '../src/auth/session';
import UsersPage from '../src/pages/UsersPage.vue';

/**
 * UI-44: one component test per slice screen — renders, shows loading, shows
 * error. Whether a step-up password is correct, and whether the last Owner is
 * being removed, are decided by the server; nothing here asserts them.
 */
const list = vi.fn();
const create = vi.fn();
const update = vi.fn();
const disable = vi.fn();

vi.mock('../src/api/users', () => ({
  fetchUsers: (token: string) => list(token),
  createUser: (token: string, payload: unknown) => create(token, payload),
  updateUser: (token: string, id: string, payload: unknown) => update(token, id, payload),
  setUserDisabled: (token: string, id: string, payload: unknown) => disable(token, id, payload),
}));

vi.mock('../src/components/shell/AppShell.vue', () => ({
  // The real shell renders a page header whose `actions` slot holds the screen's
  // primary button, so the stand-in must render that slot too.
  default: {
    name: 'AppShell',
    template: '<div><div class="page-actions"><slot name="actions" /></div><slot /></div>',
  },
}));

const OWNER = {
  id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
  username: 'karim',
  displayName: 'Karim Ahmed',
  email: null,
  phone: '01712345678',
  roleId: '01ROLEOWNERAAAAAAAAAAAAAAA',
  roleName: 'Owner',
  disabled: false,
  hasPassword: true,
};

const CASHIER = {
  id: '01BBBBBBBBBBBBBBBBBBBBBBBB',
  username: 'rahim',
  displayName: 'Rahim Uddin',
  email: null,
  phone: '01799887766',
  roleId: '01ROLECASHIERAAAAAAAAAAAAA',
  roleName: 'Cashier',
  disabled: false,
  hasPassword: false,
};

const ROLES = [
  { id: '01ROLEOWNERAAAAAAAAAAAAAAA', code: 'OWNER', name: 'Owner' },
  { id: '01ROLECASHIERAAAAAAAAAAAAA', code: 'CASHIER', name: 'Cashier' },
];

beforeEach(() => {
  const session = useSession();
  session.signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  // An owner, so the controls are offered. The hidden case has its own suite.
  session.setPermissions([
    'user.account.view',
    'user.account.create',
    'user.account.edit',
    'user.account.disable',
  ]);
  list.mockReset();
  create.mockReset();
  update.mockReset();
  disable.mockReset();
  list.mockResolvedValue({ users: [OWNER, CASHIER], roles: ROLES });
});

afterEach(() => {
  useSession().clear();
});

async function mountLoaded() {
  const wrapper = mount(UsersPage);
  await flushPromises();
  return wrapper;
}

describe('UsersPage', () => {
  it('shows a skeleton until the list arrives (UI-27)', () => {
    list.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(UsersPage);

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
  });

  it('lists everyone, and flags who cannot sign in yet', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('Karim Ahmed');
    expect(wrapper.text()).toContain('Rahim Uddin');
    expect(wrapper.text()).toContain('Owner');
    expect(wrapper.text()).toContain('Cashier');
    // The cashier has no password yet — the row says so rather than looking active.
    expect(wrapper.text()).toContain('Awaiting password');
  });

  it("shows the server's own code and message when the list fails (UI-28)", async () => {
    list.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'Permission required', 403));

    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('PERMISSION_DENIED');
    expect(wrapper.text()).toContain('Permission required');
    expect(wrapper.text()).not.toContain('Something went wrong');
  });

  it('asks for your own password when adding someone (§5.3 step-up)', async () => {
    const wrapper = await mountLoaded();

    await wrapper.find('.page-actions button').trigger('click');

    expect(wrapper.find('[role="dialog"]').exists()).toBe(true);
    expect(wrapper.find('#confirm').exists()).toBe(true);
    expect(wrapper.text()).toContain('Your password');
  });

  it('sends the new user and reloads the list', async () => {
    create.mockResolvedValue({ ...CASHIER, displayName: 'Nasrin Akter' });
    const wrapper = await mountLoaded();

    await wrapper.find('.page-actions button').trigger('click');
    await wrapper.find('#display-name').setValue('Nasrin Akter');
    await wrapper.find('#username').setValue('nasrin');
    await wrapper.find('#identifier').setValue('01711111111');
    await wrapper.find('#confirm').setValue('Passw0rd23');
    await wrapper.find('[role="dialog"] form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledWith('test-access', {
      displayName: 'Nasrin Akter',
      username: 'nasrin',
      identifier: '01711111111',
      roleId: ROLES[0]!.id,
      confirmPassword: 'Passw0rd23',
    });
    // Told what to do next: they still have no password.
    expect(wrapper.text()).toContain('Set your password');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('does not ask for a password to rename someone — that re-privileges nobody', async () => {
    const wrapper = await mountLoaded();

    // The cashier's Edit link is the first action in the second row.
    await wrapper.findAll('tbody tr')[1]!.findAll('.linkish')[0]!.trigger('click');

    expect(wrapper.find('#confirm').exists()).toBe(false);
    expect((wrapper.find('#display-name').element as HTMLInputElement).value).toBe('Rahim Uddin');
  });

  it('asks for one as soon as the role is changed', async () => {
    const wrapper = await mountLoaded();

    await wrapper.findAll('tbody tr')[1]!.findAll('.linkish')[0]!.trigger('click');
    wrapper.findComponent(Select).vm.$emit('update:modelValue', ROLES[0]!.id);
    await flushPromises();

    expect(wrapper.find('#confirm').exists()).toBe(true);
  });

  it('confirms before disabling, and says what it will do', async () => {
    const wrapper = await mountLoaded();

    await wrapper.findAll('tbody tr')[1]!.findAll('.linkish')[1]!.trigger('click');

    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.text()).toContain('Disable Rahim Uddin?');
    expect(dialog.text()).toContain('signed out everywhere');
    expect(wrapper.find('#confirm-toggle').exists()).toBe(true);
  });
});

/**
 * UI-09: "Never render a control that will 403." A Manager holds
 * `user.account.view` and nothing else, so they can see the team without being
 * offered buttons that would refuse them.
 */
describe('UsersPage for someone who may look but not change', () => {
  beforeEach(() => {
    useSession().setPermissions(['user.account.view']);
  });

  it('still lists everyone', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('Karim Ahmed');
    expect(wrapper.text()).toContain('Rahim Uddin');
  });

  it('offers no Add, and drops the actions column entirely', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).not.toContain('Add user');
    expect(wrapper.findAll('.linkish')).toHaveLength(0);
    // The column header goes too — an empty one would imply something was there.
    expect(wrapper.text()).not.toContain('Actions');
  });

  it('says why, rather than leaving the absence unexplained', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('not make changes');
  });
});

/** Editing and disabling are separate codes (§5.26), and show separately. */
describe('UsersPage for someone who may edit but not disable', () => {
  beforeEach(() => {
    useSession().setPermissions(['user.account.view', 'user.account.edit']);
  });

  it('offers Edit and withholds Disable', async () => {
    const wrapper = await mountLoaded();

    const actions = wrapper.findAll('tbody tr')[1]!.findAll('.linkish');
    expect(actions).toHaveLength(1);
    expect(actions[0]!.text()).toBe('Edit');
  });
});
