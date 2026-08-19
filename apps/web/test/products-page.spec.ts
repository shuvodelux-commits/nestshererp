import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only, so it is erased before `vi.mock` hoisting runs.
import type * as CatalogApi from '../src/api/catalog';
import { ApiError } from '../src/api/client';
import { useSession } from '../src/auth/session';
import ProductsPage from '../src/pages/ProductsPage.vue';

/**
 * UI-44: one workflow smoke test — renders, loading, error, and the two
 * permission-hidden cases.
 *
 * The one thing this suite really has to prove is UI-40: the purchase-price
 * column is absent for a caller without `inventory.cost.view`. The server does
 * not send the field at all; this checks the screen does not invent a column for
 * it either.
 */
const load = vi.fn();
const setStatus = vi.fn();
const catalog = vi.fn();
const push = vi.fn();

vi.mock('../src/api/products', () => ({
  fetchProducts: (token: string, query: unknown) => load(token, query),
  setProductStatus: (token: string, id: string, status: string) => setStatus(token, id, status),
}));

vi.mock('../src/api/catalog', async () => {
  const actual = await vi.importActual<typeof CatalogApi>('../src/api/catalog');
  return { ...actual, fetchCatalog: (token: string) => catalog(token) };
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

const COLA = {
  id: '01PRODCOLAAAAAAAAAAAAAAAAA',
  name: '500ml',
  displayName: 'Coca Cola 500ml',
  brandId: '01BRANDCOLAAAAAAAAAAAAAAAA',
  brandName: 'Coca Cola',
  categoryId: null,
  categoryName: null,
  parentCategoryName: null,
  sku: 'COLA-500',
  barcode: '8901234567890',
  description: null,
  baseUnitId: '01UNITPIECEAAAAAAAAAAAAAAA',
  baseUnitName: 'Piece',
  sellingPriceMinor: 15_000,
  purchasePriceMinor: 10_000,
  minStockQty: 24_000,
  status: 'ACTIVE' as const,
  defaultDiscountType: null,
  defaultDiscountValue: null,
  offerEnabled: false,
  offerPriceMinor: null,
  offerStartDate: null,
  offerEndDate: null,
  offerLive: false,
  tracksExpiry: false,
  tracksSerial: false,
  conversion: null,
  version: 1,
};

const SUMMARY = { total: 1, active: 1, inactive: 0, withoutBarcode: 0 };

beforeEach(() => {
  const session = useSession();
  session.signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  session.setPermissions([
    'catalog.product.view',
    'catalog.product.create',
    'catalog.product.edit',
    'catalog.product.deactivate',
    'inventory.cost.view',
  ]);
  load.mockReset();
  setStatus.mockReset();
  catalog.mockReset();
  push.mockReset();
  catalog.mockResolvedValue({
    units: [{ id: COLA.baseUnitId, name: 'Piece' }],
    brands: [{ id: COLA.brandId, name: 'Coca Cola' }],
    categories: [],
    features: {
      productOffers: true,
      expiryTracking: false,
      serialTracking: false,
      customerGroups: false,
      vendors: false,
    },
  });
  load.mockResolvedValue({
    data: [COLA],
    page: { nextCursor: null, hasMore: false },
    summary: SUMMARY,
  });
});

afterEach(() => {
  useSession().clear();
});

async function mountLoaded() {
  const wrapper = mount(ProductsPage);
  await flushPromises();
  return wrapper;
}

describe('ProductsPage', () => {
  it('shows a skeleton until the products arrive (UI-27)', () => {
    load.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(ProductsPage);

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
  });

  it('shows the display name and both prices formatted as money (UI-32)', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('Coca Cola 500ml');
    expect(wrapper.text()).toContain('৳150.00');
    expect(wrapper.text()).toContain('৳100.00');
    // A reorder level is a scale-3 quantity, formatted by shared-utils.
    expect(wrapper.text()).toContain('24.000');
  });

  it("shows the server's own code and message on failure (UI-28)", async () => {
    load.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'Permission required', 403));

    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('PERMISSION_DENIED');
    expect(wrapper.text()).toContain('Permission required');
    expect(wrapper.text()).not.toContain('Something went wrong');
  });

  it('counts the tiles from the same figures the server sent', async () => {
    const wrapper = await mountLoaded();

    const tiles = wrapper.findAll('.tiles article');
    expect(tiles).toHaveLength(4);
    expect(tiles[0]!.text()).toContain('1');
  });

  it('deactivates through a confirmation that names the consequence (UI-26)', async () => {
    setStatus.mockResolvedValue({ ...COLA, status: 'INACTIVE' });
    const wrapper = await mountLoaded();

    await wrapper.find('.actions .danger').trigger('click');
    expect(wrapper.text()).toContain('Deactivate Coca Cola 500ml?');
    expect(wrapper.text()).toContain('Everything already recorded about it stays');

    await wrapper.find('[role="dialog"] .btn-danger').trigger('click');
    await flushPromises();

    expect(setStatus).toHaveBeenCalledWith('test-access', COLA.id, 'INACTIVE');
  });

  it('asks the server again when a filter changes, never filtering in the browser', async () => {
    const wrapper = await mountLoaded();
    load.mockClear();

    await wrapper.find('#filter-status').setValue('INACTIVE');
    await flushPromises();

    expect(load).toHaveBeenCalledWith('test-access', { status: 'INACTIVE' });
  });
});

/**
 * UI-40 / R-E8: cost is its own permission, and the field is not sent at all.
 * The screen must not draw a column for a figure it will never receive.
 */
describe('ProductsPage without inventory.cost.view', () => {
  beforeEach(() => {
    useSession().setPermissions(['catalog.product.view']);
    load.mockResolvedValue({
      // Exactly what the server sends such a caller: no `purchasePriceMinor` key.
      data: [{ ...COLA, purchasePriceMinor: undefined }],
      page: { nextCursor: null, hasMore: false },
      summary: SUMMARY,
    });
  });

  it('shows no purchase column and says why', async () => {
    const wrapper = await mountLoaded();

    const headers = wrapper.findAll('thead th').map((cell) => cell.text());
    expect(headers).toContain('Selling');
    expect(headers).not.toContain('Purchase');
    expect(wrapper.text()).toContain('not sent to this screen at all');
  });

  it('offers no Add, no Edit and no Deactivate', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.find('.page-actions button').exists()).toBe(false);
    expect(wrapper.findAll('.actions .linkish')).toHaveLength(0);
  });
});
