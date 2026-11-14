/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:party-form
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only, so it is erased before `vi.mock` hoisting runs.
import type * as PartiesApi from '../src/api/parties';
import { useSession } from '../src/auth/session';
import { fetchParty, updateParty } from '../src/api/parties';
import PartyFormPage from '../src/pages/PartyFormPage.vue';

/**
 * UI-44: the workflow smoke test this page never had.
 *
 * Its absence is why a `PartyFormPage.vue` that could not render passed lint,
 * typecheck and the whole suite — nothing mounted it, so nothing noticed. The
 * first assertion here is deliberately the dullest one in the codebase: **the
 * page renders at all**. A template that fails to parse is a total outage of
 * the screen, and it is exactly the class of defect a type checker does not see.
 */
const create = vi.fn();
const setup = vi.fn();
const push = vi.fn();
const routeState = vi.hoisted(() => ({ params: { id: 'new' }, query: {} as Record<string, string> }));

vi.mock('../src/api/parties', async () => {
  const actual = await vi.importActual<typeof PartiesApi>('../src/api/parties');
  return {
    ...actual,
    fetchPartySetup: (token: string) => setup(token),
    createParty: (token: string, payload: unknown, key: string) => create(token, payload, key),
    fetchParty: vi.fn(),
    updateParty: vi.fn(),
    deleteParty: vi.fn(),
  };
});

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => routeState,
}));

vi.mock('../src/components/shell/AppShell.vue', () => ({
  default: { name: 'AppShell', template: '<div><slot /></div>' },
}));

const ALL_FIELDS = {
  address: true,
  guardianName: true,
  nid: true,
  email: true,
  notes: true,
};

beforeEach(() => {
  const session = useSession();
  session.signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  session.setPermissions([
    'party.customer.view',
    'party.customer.create',
    'party.customer.edit',
    'party.supplier.view',
    'party.vendor.view',
  ]);
  routeState.params.id = 'new';
  routeState.query = {};
  vi.mocked(fetchParty).mockReset();
  vi.mocked(updateParty).mockReset();
  create.mockReset();
  setup.mockReset();
  push.mockReset();
  setup.mockResolvedValue({
    groups: [],
    features: { customerGroups: true, vendors: false },
    fields: ALL_FIELDS,
  });
});

afterEach(() => {
  useSession().clear();
});

async function mountForm() {
  const wrapper = mount(PartyFormPage);
  await flushPromises();
  return wrapper;
}

describe('the customer form', () => {
  it('renders', async () => {
    const wrapper = await mountForm();

    expect(wrapper.find('#party-name').exists()).toBe(true);
    expect(wrapper.find('form').exists()).toBe(true);
  });

  it('opens with the fields a shopkeeper starts with, in that order', async () => {
    // Owner decision 2026-08-19: name → guardian, phone → address. Asserted as
    // an order, not a set, because the order is the thing that was specified.
    const wrapper = await mountForm();
    const html = wrapper.html();

    const positions = ['party-name', 'party-guardian', 'party-phone', 'party-address'].map((id) =>
      html.indexOf(id),
    );

    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('keeps saving out of the folded section', async () => {
    // The save button once ended up inside "More details" while restructuring.
    // Folding away the point of the screen is worse than any missing field.
    const wrapper = await mountForm();
    const actions = wrapper.find('.form-actions');

    expect(actions.exists()).toBe(true);
    expect(actions.element.closest('.is-collapsed')).toBeNull();
  });

  it('folds the fields a customer can exist without', async () => {
    const wrapper = await mountForm();

    // Present in the DOM — v-show, so nothing typed is dropped — but inside the
    // collapsed card rather than on the opening screen.
    const nid = wrapper.find('#party-nid');
    expect(nid.exists()).toBe(true);
    expect(wrapper.text()).toContain('More details');
  });

  it('sends what was typed, with the operation id it opened with (UI-34)', async () => {
    const wrapper = await mountForm();

    await wrapper.find('#party-name').setValue('Karim Uddin');
    await wrapper.find('#party-phone').setValue('01712345678');
    create.mockResolvedValue({ id: '01PARTYAAAAAAAAAAAAAAAAAAA' });

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledTimes(1);
    const [, payload, key] = create.mock.calls[0]!;
    expect((payload as { name: string }).name).toBe('Karim Uddin');
    expect((payload as { phone: string }).phone).toBe('01712345678');
    expect(typeof key).toBe('string');
  });

  it('will not save a customer with no phone (D-02)', async () => {
    const wrapper = await mountForm();

    await wrapper.find('#party-name').setValue('Karim Uddin');
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(create).not.toHaveBeenCalled();
  });
});

const editRow = {
  id: '01AAAAAAAAAAAAAAAAAAAAAAAA', name: 'Karim', phone: '01712345678', roles: ['CUSTOMER' as const],
  readRole: 'CUSTOMER' as const, profile: { state: 'WITHHELD' as const },
  globalHistory: { state: 'WITHHELD' as const }, customerGroupId: null, customerGroupName: null,
  creditLimitMinor: null, version: 2, status: 'ACTIVE' as const, isSystemReserved: false,
  balance: { netMinor: 0, outstandingMinor: 0, advanceMinor: 0, direction: 'SETTLED' as const },
};

describe('V2 Party form reads', () => {
  it('uses the embedded selected role and hides withheld private fields', async () => {
    vi.mocked(fetchParty).mockResolvedValue({ ...editRow, readRole: 'SUPPLIER', roles: ['SUPPLIER'] });
    const wrapper = mount(PartyFormPage, { props: { embedded: true, embeddedPartyId: editRow.id, embeddedRole: 'SUPPLIER' } });
    await flushPromises();
    expect(fetchParty).toHaveBeenCalledWith('test-access', editRow.id, 'SUPPLIER');
    expect(wrapper.find('#party-address').exists()).toBe(false);
    expect(wrapper.find('#party-nid').exists()).toBe(false);
    expect(wrapper.find('#party-name').element).toHaveProperty('value', 'Karim');
  });

  it('refetches V2 after PATCH instead of filling the raw private echo', async () => {
    routeState.params.id = editRow.id;
    routeState.query = { role: 'CUSTOMER', mode: 'edit' };
    vi.mocked(fetchParty).mockResolvedValue(editRow);
    vi.mocked(updateParty).mockResolvedValue({ ...editRow, address: 'RAW SECRET' } as unknown as Awaited<ReturnType<typeof updateParty>>);
    const wrapper = await mountForm();
    await wrapper.find('#party-name').setValue('Renamed');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(updateParty).toHaveBeenCalled();
    expect(fetchParty).toHaveBeenCalledTimes(2);
    expect(wrapper.html()).not.toContain('RAW SECRET');
    expect(wrapper.find('#party-address').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Delete');
  });

  it('fills an authorized visible profile', async () => {
    routeState.params.id = editRow.id;
    routeState.query = { role: 'CUSTOMER', mode: 'edit' };
    vi.mocked(fetchParty).mockResolvedValue({ ...editRow, profile: { state: 'VISIBLE', data: { address: 'Visible street', guardianName: 'Guardian', nid: null, email: null, notes: null } } });
    const wrapper = await mountForm();
    expect(wrapper.find('#party-address').element).toHaveProperty('value', 'Visible street');
    expect(wrapper.find('#party-guardian').element).toHaveProperty('value', 'Guardian');
  });

  it('emits only safe identity after create and preserves role-specific opening creation', async () => {
    create.mockResolvedValue({ id: editRow.id, name: 'Karim', address: 'RAW SECRET' });
    const wrapper = mount(PartyFormPage, { props: { embedded: true } });
    await flushPromises();
    await wrapper.find('#party-name').setValue('Karim');
    await wrapper.find('#party-phone').setValue('01712345678');
    await wrapper.find('#party-opening').setValue('25.50');
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(create.mock.calls[0]?.[1]).toMatchObject({ opening: { role: 'CUSTOMER', amountMinor: 2550 } });
    expect(wrapper.emitted('saved')?.[0]?.[0]).toEqual({ id: editRow.id, name: 'Karim' });
  });
});


describe('full-form identity write safety', () => {
  it('does not remove relationships hidden by V2 role filtering', async () => {
    routeState.params.id = editRow.id;
    routeState.query = { role: 'CUSTOMER', mode: 'edit' };
    useSession().setPermissions(['party.customer.view', 'party.customer.edit']);
    vi.mocked(fetchParty).mockResolvedValue(editRow);
    const wrapper = await mountForm();
    await wrapper.find('form').trigger('submit');
    await flushPromises();
    expect(updateParty).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Editing needs visibility of all party relationships');
  });
});

it('preserves customer credit through repeated supplier-context edits', async () => {
  routeState.params.id = editRow.id;
  routeState.query = { role: 'SUPPLIER', mode: 'edit' };
  const supplier = { ...editRow, readRole: 'SUPPLIER' as const, roles: ['CUSTOMER' as const, 'SUPPLIER' as const] };
  vi.mocked(fetchParty).mockImplementation(async (_token, _id, role) => role === 'CUSTOMER'
    ? { ...supplier, readRole: 'CUSTOMER', creditLimitMinor: 123400 }
    : supplier);
  vi.mocked(updateParty).mockResolvedValue({} as Awaited<ReturnType<typeof updateParty>>);
  const wrapper = await mountForm();
  for (const name of ['First edit', 'Second edit']) {
    await wrapper.find('#party-name').setValue(name);
    await wrapper.find('form').trigger('submit');
    await flushPromises();
  }
  expect(updateParty).toHaveBeenCalledTimes(2);
  for (const call of vi.mocked(updateParty).mock.calls) {
    expect(call[2]).toMatchObject({ creditLimitMinor: 123400, roles: ['CUSTOMER', 'SUPPLIER'] });
  }
  expect(wrapper.find('#party-credit').exists()).toBe(false);
});
