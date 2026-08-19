import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only, so it is erased before `vi.mock` hoisting runs.
import type * as PartiesApi from '../src/api/parties';
import { ApiError } from '../src/api/client';
import { useSession } from '../src/auth/session';
import PartiesPage from '../src/pages/PartiesPage.vue';

/**
 * UI-44: one workflow smoke test — renders, loading, error, and the
 * permission- and feature-hidden cases.
 *
 * The two things this suite really has to prove:
 *
 *   §5.6's rule that no screen shows every party type at once — the tab is part
 *   of every request, and changing it asks the server again rather than
 *   filtering rows already in the browser.
 *
 *   UI-09's rule that a control which would be refused is **absent**: no
 *   Vendors tab while vendors are switched off, and no Add button for a role the
 *   caller cannot create.
 */
const load = vi.fn();
const setStatus = vi.fn();
const setup = vi.fn();
const push = vi.fn();

vi.mock('../src/api/parties', async () => {
  const actual = await vi.importActual<typeof PartiesApi>('../src/api/parties');
  return {
    ...actual,
    fetchParties: (token: string, query: unknown) => load(token, query),
    fetchPartySetup: (token: string) => setup(token),
    setPartyStatus: (token: string, id: string, status: string) => setStatus(token, id, status),
  };
});

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
}));

vi.mock('../src/components/shell/AppShell.vue', () => ({
  default: {
    name: 'AppShell',
    template: '<div><div class="page-actions"><slot name="actions" /></div><slot /></div>',
  },
}));

const KARIM = {
  id: '01PARTYKARIMAAAAAAAAAAAAAA',
  name: 'Karim Uddin',
  roles: ['CUSTOMER' as const],
  phone: '01712345678',
  address: null,
  guardianName: null,
  nid: null,
  email: null,
  notes: null,
  customerGroupId: null,
  customerGroupName: null,
  creditLimitMinor: 500_000,
  status: 'ACTIVE' as const,
  isSystemReserved: false,
  version: 1,
};

const SUMMARY = { total: 1, active: 1, inactive: 0, ungrouped: 1 };

const ALL_RIGHTS = [
  'party.customer.view',
  'party.customer.create',
  'party.customer.edit',
  'party.customer.deactivate',
  'party.supplier.view',
  'party.supplier.create',
];

beforeEach(() => {
  const session = useSession();
  session.signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  session.setPermissions(ALL_RIGHTS);
  load.mockReset();
  setStatus.mockReset();
  setup.mockReset();
  push.mockReset();
  setup.mockResolvedValue({
    groups: [],
    features: { customerGroups: false, vendors: false },
    fields: { address: true, guardianName: false, nid: false, email: false, notes: false },
  });
  load.mockResolvedValue({
    data: [KARIM],
    page: { nextCursor: null, hasMore: false },
    summary: SUMMARY,
  });
});

afterEach(() => {
  useSession().clear();
});

async function mountLoaded() {
  const wrapper = mount(PartiesPage);
  await flushPromises();
  return wrapper;
}

describe('PartiesPage', () => {
  it('shows a skeleton until the list arrives (UI-27)', () => {
    load.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(PartiesPage);

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
  });

  it('asks for customers first and formats the credit limit as money (UI-32)', async () => {
    const wrapper = await mountLoaded();

    expect(load).toHaveBeenCalledWith('test-access', { role: 'CUSTOMER' });
    expect(wrapper.text()).toContain('Karim Uddin');
    expect(wrapper.text()).toContain('01712345678');
    // ৳5,000.00 — formatted by shared-utils, never divided in the component.
    expect(wrapper.text()).toContain('৳5,000.00');
  });

  it("shows the server's own code and message on failure (UI-28)", async () => {
    load.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'Permission required', 403));

    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('PERMISSION_DENIED');
    expect(wrapper.text()).toContain('Permission required');
    expect(wrapper.text()).not.toContain('Something went wrong');
  });

  it('asks the server again when the tab changes, never filtering in the browser', async () => {
    const wrapper = await mountLoaded();
    load.mockClear();

    await wrapper.findAll('.tab')[1]!.trigger('click');
    await flushPromises();

    expect(load).toHaveBeenCalledWith('test-access', { role: 'SUPPLIER' });
  });

  it('deactivates through a confirmation that names the consequence (UI-26)', async () => {
    setStatus.mockResolvedValue({ ...KARIM, status: 'INACTIVE' });
    const wrapper = await mountLoaded();

    await wrapper.find('.actions .danger').trigger('click');
    expect(wrapper.text()).toContain('Deactivate Karim Uddin?');
    expect(wrapper.text()).toContain('stays exactly as it is');

    await wrapper.find('[role="dialog"] .btn-danger').trigger('click');
    await flushPromises();

    expect(setStatus).toHaveBeenCalledWith('test-access', KARIM.id, 'INACTIVE');
  });

  it('offers no action at all on the walk-in customer (D-02)', async () => {
    load.mockResolvedValue({
      data: [{ ...KARIM, name: 'Walk-in Customer', phone: null, isSystemReserved: true }],
      page: { nextCursor: null, hasMore: false },
      summary: SUMMARY,
    });

    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('Walk-in');
    expect(wrapper.find('.actions .linkish').exists()).toBe(false);
  });
});

/**
 * UI-09: a destination or control the shop has switched off, or the caller
 * cannot use, is **absent** — not disabled. A disabled control still advertises
 * a feature nobody chose.
 */
describe('PartiesPage with features off and rights missing', () => {
  it('shows no Vendors tab while vendors are switched off', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.findAll('.tab').map((tab) => tab.text())).toEqual([
      'Customers',
      'Suppliers',
    ]);
  });

  it('shows the Vendors tab once vendors are switched on and the caller may see them', async () => {
    useSession().setPermissions([...ALL_RIGHTS, 'party.vendor.view']);
    setup.mockResolvedValue({
      groups: [],
      features: { customerGroups: false, vendors: true },
      fields: { address: true, guardianName: false, nid: false, email: false, notes: false },
    });

    const wrapper = await mountLoaded();

    expect(wrapper.findAll('.tab').map((tab) => tab.text())).toEqual([
      'Customers',
      'Suppliers',
      'Vendors',
    ]);
  });

  it('hides Add and the row actions from a caller who may only look', async () => {
    useSession().setPermissions(['party.customer.view']);

    const wrapper = await mountLoaded();

    expect(wrapper.find('.page-actions .btn-primary').exists()).toBe(false);
    expect(wrapper.find('.actions .linkish').exists()).toBe(false);
  });

  it('hides the group column and the group filter while groups are off', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.find('#filter-group').exists()).toBe(false);
    expect(wrapper.find('.page-actions .pi-tags').exists()).toBe(false);
  });
});
