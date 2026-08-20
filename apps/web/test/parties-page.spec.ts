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
 *   §5.6/UI-55's rule that no screen shows every party type at once — the
 *   independent sidebar route supplies the role in every request.
 *
 *   UI-09's rule that a control which would be refused is **absent**: no
 *   Vendors tab while vendors are switched off, and no Add button for a role the
 *   caller cannot create.
 */
const load = vi.fn();
const create = vi.fn();
const setStatus = vi.fn();
const setup = vi.fn();
const push = vi.fn();
const replace = vi.fn();
const routeState = vi.hoisted(() => ({ query: {} as Record<string, string> }));

vi.mock('../src/api/parties', async () => {
  const actual = await vi.importActual<typeof PartiesApi>('../src/api/parties');
  return {
    ...actual,
    fetchParties: (token: string, query: unknown) => load(token, query),
    fetchPartySetup: (token: string) => setup(token),
    createParty: (token: string, body: unknown, operationId: string) => create(token, body, operationId),
    setPartyStatus: (token: string, id: string, status: string) => setStatus(token, id, status),
  };
});

vi.mock('vue-router', () => ({
  useRoute: () => routeState,
  useRouter: () => ({ push, replace }),
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
  create.mockReset();
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
  routeState.query = {};
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

  it('asks for customers first without using credit limit as a balance column', async () => {
    const wrapper = await mountLoaded();

    expect(load).toHaveBeenCalledWith('test-access', expect.objectContaining({ role: 'CUSTOMER' }));
    expect(wrapper.text()).toContain('Karim Uddin');
    expect(wrapper.text()).toContain('01712345678');
    expect(wrapper.text()).not.toContain('Credit limit');
    expect(wrapper.text()).not.toContain('৳5,000.00');
  });

  it("shows the server's own code and message on failure (UI-28)", async () => {
    load.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'Permission required', 403));

    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('PERMISSION_DENIED');
    expect(wrapper.text()).toContain('Permission required');
    expect(wrapper.text()).not.toContain('Something went wrong');
  });

  it('uses the independent sidebar route as the supplier list context', async () => {
    routeState.query = { role: 'SUPPLIER' };
    await mountLoaded();
    expect(load).toHaveBeenCalledWith('test-access', expect.objectContaining({ role: 'SUPPLIER' }));
  });

  it('uses the page for customer and supplier rows instead of redundant summary cards', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.find('.tiles').exists()).toBe(false);
    expect(wrapper.find('.table-wrap').exists()).toBe(true);
    expect(wrapper.find('.paging').text()).toContain('Showing 1 of 1');

    expect(wrapper.find('.tabs').exists()).toBe(false);
  });

  it('adds a customer in a modal through the existing party create API', async () => {
    create.mockResolvedValue({ ...KARIM, id: '01NEWCUSTOMERAAAAAAAAAAAA' });
    const wrapper = await mountLoaded();

    await wrapper.find('.page-actions .btn-primary').trigger('click');
    await flushPromises();
    const name = document.querySelector<HTMLInputElement>('#create-party-name');
    const phone = document.querySelector<HTMLInputElement>('#create-party-phone');
    const form = document.querySelector<HTMLFormElement>('#create-party-form');
    expect(name).not.toBeNull();
    expect(phone).not.toBeNull();
    expect(form).not.toBeNull();
    name!.value = 'New Customer';
    name!.dispatchEvent(new Event('input', { bubbles: true }));
    phone!.value = '01812345678';
    phone!.dispatchEvent(new Event('input', { bubbles: true }));
    form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();

    expect(create).toHaveBeenCalledWith(
      'test-access',
      expect.objectContaining({ name: 'New Customer', phone: '01812345678', roles: ['CUSTOMER'] }),
      expect.any(String),
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('deactivates through a confirmation that names the consequence (UI-26)', async () => {
    setStatus.mockResolvedValue({ ...KARIM, status: 'INACTIVE' });
    const wrapper = await mountLoaded();

    await wrapper.find('.row-menu-trigger').trigger('click');
    await flushPromises();
    const deactivate = [...document.body.querySelectorAll<HTMLElement>('.p-menu-item')]
      .find((item) => item.textContent?.includes('Deactivate'));
    expect(deactivate).toBeDefined();
    (deactivate!.querySelector<HTMLElement>('.p-menu-item-link') ?? deactivate!).click();
    await flushPromises();
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
    expect(wrapper.find('.row-menu-trigger').exists()).toBe(false);
  });
});

/**
 * UI-09: a destination or control the shop has switched off, or the caller
 * cannot use, is **absent** — not disabled. A disabled control still advertises
 * a feature nobody chose.
 */
describe('PartiesPage with features off and rights missing', () => {
  it('does not repeat Customer, Supplier or Vendor navigation inside the page', async () => {
    const wrapper = await mountLoaded();
    expect(wrapper.find('.tabs').exists()).toBe(false);
  });

  it('hides Add and the row actions from a caller who may only look', async () => {
    useSession().setPermissions(['party.customer.view']);

    const wrapper = await mountLoaded();

    expect(wrapper.find('.page-actions .btn-primary').exists()).toBe(false);
    expect(wrapper.find('.row-menu-trigger').exists()).toBe(false);
  });

  it('hides the group column and the group filter while groups are off', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.find('#filter-group').exists()).toBe(false);
    expect(wrapper.find('.page-actions .pi-tags').exists()).toBe(false);
  });
});
