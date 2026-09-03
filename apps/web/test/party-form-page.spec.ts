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
  useRoute: () => ({ params: { id: 'new' }, query: {} }),
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
  ]);
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
