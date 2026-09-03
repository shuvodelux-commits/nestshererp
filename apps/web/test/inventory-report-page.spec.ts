/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:inventory-report
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api/client';
import { useSession } from '../src/auth/session';
import InventoryReportPage from '../src/pages/InventoryReportPage.vue';

/**
 * The Inventory Report (§5.10) — the cross-product half of what used to be the
 * Inventory page. Its per-product half moved to the Products row menu, and the
 * behaviour that came with it is covered by `products-page.spec.ts`.
 *
 * What is asserted here is what would be expensive to discover late: that an
 * active zero-stock product stays visible (G2.3), that a refusal is shown
 * rather than swallowed into an empty table, that the written-off section reads
 * from the adjustment trail, and that a movement still opens its source
 * transaction (§5.20's "Why?").
 */
const load = vi.fn();
const loadLots = vi.fn();
const loadValuation = vi.fn();
const loadAdjustments = vi.fn();
const loadCostAdjustments = vi.fn();
const loadOpening = vi.fn();

vi.mock('../src/api/inventory', () => ({
  fetchInventory: (token: string, query: unknown) => load(token, query),
  fetchInventoryLots: (token: string, query: unknown) => loadLots(token, query),
  fetchInventoryValuation: (token: string) => loadValuation(token),
  fetchStockAdjustments: (token: string, query: unknown) => loadAdjustments(token, query),
  fetchCostAdjustments: (token: string, query: unknown) => loadCostAdjustments(token, query),
  fetchOpeningStock: (token: string, id: string) => loadOpening(token, id),
}));

vi.mock('../src/components/shell/AppShell.vue', () => ({
  default: { name: 'AppShell', template: '<div><slot /></div>' },
}));

const movement = {
  id: '01MOVEMENTAAAAAAAAAAAAAAAA',
  productId: '01PRODRICEAAAAAAAAAAAAAAAA',
  productName: 'Rice',
  locationName: 'Main Shop',
  lotId: '01LOTRICEAAAAAAAAAAAAAAAAA',
  qty: 10_000,
  direction: 'IN',
  sourceType: 'OPENING_STOCK',
  sourceId: '01OPENINGAAAAAAAAAAAAAAAAA',
  sourceNumber: 'OPENING_STOCK-2026-000001',
  businessDate: '2026-08-20',
  createdAt: '2026-08-20T00:00:00.000Z',
  unitCost: 1_000_000,
};

beforeEach(() => {
  const session = useSession();
  session.signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  session.setPermissions([
    'catalog.product.view',
    'catalog.product.create',
    'inventory.cost.view',
    'inventory.lot.view',
  ]);

  for (const mock of [load, loadLots, loadValuation, loadAdjustments, loadCostAdjustments, loadOpening]) {
    mock.mockReset();
  }

  load.mockResolvedValue({
    stock: [
      {
        productId: '01PRODRICEAAAAAAAAAAAAAAAA',
        productName: 'Rice',
        productStatus: 'ACTIVE',
        baseUnitName: 'Kg',
        tracksExpiry: false,
        locationId: null,
        locationName: null,
        qtyOnHand: 0,
        minStockQty: 5_000,
        stockStatus: 'ZERO_STOCK',
        valueMinor: 0,
      },
    ],
    movements: [movement],
  });
  loadLots.mockResolvedValue({
    data: [],
    page: { nextCursor: null, hasMore: false },
    valuationMethod: 'FIFO',
  });
  loadValuation.mockResolvedValue({
    method: 'FIFO',
    rows: [],
    totalValueMinor: 100_000,
    inventoryAccountMinor: 100_000,
    differenceMinor: 0,
    reconciled: true,
  });
  loadAdjustments.mockResolvedValue([]);
  loadCostAdjustments.mockResolvedValue([]);
  loadOpening.mockResolvedValue({
    id: '01OPENINGAAAAAAAAAAAAAAAAA',
    number: 'OPENING_STOCK-2026-000001',
    productId: '01PRODRICEAAAAAAAAAAAAAAAA',
    productName: 'Rice',
    locationId: '01LOCATIONAAAAAAAAAAAAAAAA',
    locationName: 'Main Shop',
    qty: 10_000,
    unitCost: 1_000_000,
    valueMinor: 100_000,
    businessDate: '2026-08-20',
    expiryDate: null,
  });
});

afterEach(() => useSession().clear());

describe('the Inventory Report', () => {
  // G2.3: active and zero-stock are independent. A product that has run out is
  // still a product the shop sells, and hiding it is how a reorder gets missed.
  it('keeps an active zero-stock product visible, and says it is out', async () => {
    const wrapper = mount(InventoryReportPage);
    await flushPromises();

    expect(wrapper.text()).toContain('Rice');
    expect(wrapper.text()).toContain('Low and out of stock');
    expect(wrapper.text()).toContain('zero stock');
  });

  // INV-05 is the whole point of the card: valuation against the INVENTORY
  // account, reconciled server-side rather than subtracted here.
  it('shows the valuation reconciled against the ledger', async () => {
    const wrapper = mount(InventoryReportPage);
    await flushPromises();

    expect(wrapper.text()).toContain('Stock value');
    expect(wrapper.text()).toContain('৳1,000.00');
    expect(wrapper.text()).toContain('Do they agree?');
    expect(wrapper.text()).toContain('Yes');
  });

  it('shows the server’s refusal instead of an empty table', async () => {
    load.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'Permission required', 403));
    const wrapper = mount(InventoryReportPage);
    await flushPromises();

    expect(wrapper.text()).toContain('PERMISSION_DENIED');
    expect(wrapper.text()).toContain('Permission required');
  });

  it('lists what was written off, with its reason and who did it', async () => {
    loadAdjustments.mockResolvedValue([
      {
        id: '01ADJUSTAAAAAAAAAAAAAAAAAA',
        number: 'STOCK_ADJUSTMENT-2026-000001',
        productId: '01PRODRICEAAAAAAAAAAAAAAAA',
        productName: 'Rice',
        locationName: 'Main Shop',
        qtyDelta: -3_000,
        direction: 'OUT',
        qty: 3_000,
        reason: 'DAMAGE',
        note: 'Sack torn in the rain',
        businessDate: '2026-08-20',
        createdAt: '2026-08-20T00:00:00.000Z',
        createdByName: 'Karim',
        valueMinor: 30_000,
      },
    ]);

    const wrapper = mount(InventoryReportPage);
    await flushPromises();

    expect(wrapper.text()).toContain('Damaged and written off');
    expect(wrapper.text()).toContain('Damaged');
    expect(wrapper.text()).toContain('Sack torn in the rain');
    expect(wrapper.text()).toContain('-3');
    expect(wrapper.text()).toContain('৳300.00');
    expect(wrapper.text()).toContain('Karim');
  });

  // §5.20's explainability requirement: a figure opens the transaction behind it.
  it('opens a movement’s posted source transaction without leaving the report', async () => {
    const wrapper = mount(InventoryReportPage, { global: { stubs: { teleport: true } } });
    await flushPromises();

    await wrapper.get('.source-link').trigger('click');
    await flushPromises();

    expect(loadOpening).toHaveBeenCalledWith('test-access', '01OPENINGAAAAAAAAAAAAAAAAA');
    expect(wrapper.text()).toContain('Opening quantity');
    expect(wrapper.text()).toContain('10');
    expect(wrapper.text()).toContain('৳1,000.00');
  });

  // UI-40 / R-E8: a role without cost sees no value column, and the figures
  // never reach the page in the first place.
  it('asks for no cost data at all without inventory.cost.view', async () => {
    useSession().setPermissions(['catalog.product.view']);
    const wrapper = mount(InventoryReportPage);
    await flushPromises();

    expect(loadValuation).not.toHaveBeenCalled();
    expect(loadCostAdjustments).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('not sent to this screen at all');
  });
});
