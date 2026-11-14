import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSession } from '../src/auth/session';
import PartyLedgerPage from '../src/pages/PartyLedgerPage.vue';

const mocks = vi.hoisted(() => ({ party: vi.fn(), ledger: vi.fn(), opening: vi.fn(), push: vi.fn() }));
vi.mock('../src/api/parties', async (original) => ({
  ...await original<typeof import('../src/api/parties')>(),
  fetchParty: mocks.party, fetchPartyLedger: mocks.ledger, fetchPartyOpening: mocks.opening,
}));
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'party-id' }, query: { role: 'SUPPLIER' } }),
  useRouter: () => ({ push: mocks.push }),
}));
vi.mock('../src/components/shell/AppShell.vue', () => ({ default: { template: '<div><slot /></div>' } }));
vi.mock('../src/state/data-freshness', () => ({ onDataChanged: vi.fn() }));

const party = {
  id: 'party-id', name: 'Supplier', phone: '01712345678', roles: ['SUPPLIER'], readRole: 'SUPPLIER',
  profile: { state: 'WITHHELD' }, globalHistory: { state: 'WITHHELD' },
  customerGroupId: null, customerGroupName: null, creditLimitMinor: null,
  status: 'ACTIVE', version: 1, isSystemReserved: false,
  balance: { netMinor: 0, direction: 'SETTLED', outstandingMinor: 0, advanceMinor: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  useSession().signIn({ accessToken: 'token', refreshToken: 'refresh' }, 'cashier');
  useSession().setPermissions(['party.supplier.view', 'party.supplier.edit']);
  mocks.party.mockResolvedValue(party);
  mocks.ledger.mockResolvedValue(null);
  mocks.opening.mockResolvedValue(null);
});
afterEach(() => useSession().clear());

it('uses supplier V2 detail and selected-role opening while retaining the ledger read', async () => {
  const wrapper = mount(PartyLedgerPage);
  await flushPromises();
  expect(mocks.party).toHaveBeenCalledWith('token', 'party-id', 'SUPPLIER');
  expect(mocks.opening).toHaveBeenCalledWith('token', 'party-id', 'SUPPLIER');
  expect(mocks.ledger).toHaveBeenCalledWith('token', 'party-id', { limit: 50 });
  expect(wrapper.text()).toContain('Supplier');
  expect(wrapper.text()).toContain('Set opening balance');
  expect(wrapper.text()).toContain('01712345678');
  wrapper.unmount();
});

it('renders visible profile address but never a raw address alongside withheld profile', async () => {
  mocks.party.mockResolvedValue({ ...party, address: 'RAW SECRET' });
  const hidden = mount(PartyLedgerPage);
  await flushPromises();
  expect(hidden.text()).not.toContain('RAW SECRET');
  hidden.unmount();
  mocks.party.mockResolvedValue({ ...party, profile: { state: 'VISIBLE', data: { address: 'Visible street' } } });
  const visible = mount(PartyLedgerPage);
  await flushPromises();
  expect(visible.text()).toContain('Visible street');
  visible.unmount();
});
