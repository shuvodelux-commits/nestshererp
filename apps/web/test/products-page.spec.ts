import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only, so it is erased before `vi.mock` hoisting runs.
import type * as CatalogApi from '../src/api/catalog';
import { ApiError } from '../src/api/client';
import { useSession } from '../src/auth/session';
import ProductsPage from '../src/pages/ProductsPage.vue';

/**
 * UI-44: one workflow smoke test — renders, loading, error, and the
 * permission-hidden cases.
 *
 * The one thing this suite really has to prove is UI-40: the purchase-price and
 * stock-value columns are absent for a caller without `inventory.cost.view`. The
 * server does not send those fields at all; this checks the screen does not
 * invent a column for them either.
 *
 * Since §5.5 made Products the product working hub, it also proves the `⋯` row
 * menu offers the right actions — and, for §3.6, that `Delete` is **not**
 * offered for a product that has stock history, because that action would
 * always be refused.
 */
const load = vi.fn();
const setStatus = vi.fn();
const removeProduct = vi.fn();
const catalog = vi.fn();
const push = vi.fn();

vi.mock('../src/api/products', () => ({
  fetchProducts: (token: string, query: unknown) => load(token, query),
  setProductStatus: (token: string, id: string, status: string) => setStatus(token, id, status),
  deleteProduct: (token: string, id: string) => removeProduct(token, id),
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

// The form is its own component with its own suite; mounting it here would test
// it a second time and drag its catalog calls into this one (R-E12).
vi.mock('../src/components/ProductForm.vue', () => ({
  default: { name: 'ProductForm', template: '<div class="product-form-stub" />' },
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
  // §5.5's stock columns, supplied by the read model rather than counted here.
  stockQty: 48_000,
  stockValueMinor: 480_000,
  stockStatus: 'IN_STOCK' as const,
  hasStockHistory: true,
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
    'catalog.product.delete',
    'inventory.cost.view',
    'inventory.lot.view',
  ]);
  load.mockReset();
  setStatus.mockReset();
  removeProduct.mockReset();
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
  const wrapper = mount(ProductsPage, { global: { stubs: { teleport: true } } });
  await flushPromises();
  return wrapper;
}

/** Open the `⋯` menu for the first row and read back what it offers. */
async function rowMenuLabels(wrapper: Awaited<ReturnType<typeof mountLoaded>>) {
  await wrapper.get('.row-menu-trigger').trigger('click');
  await flushPromises();
  return wrapper.findAll('.p-menu-item-label').map((item) => item.text());
}

describe('ProductsPage', () => {
  it('shows a skeleton until the products arrive (UI-27)', () => {
    load.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(ProductsPage);

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
  });

  it('shows the essential product columns and both prices formatted as money (UI-32)', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('Coca Cola 500ml');
    expect(wrapper.text()).toContain('৳150.00');
    expect(wrapper.text()).toContain('৳100.00');
    const headers = wrapper.findAll('thead th').map((cell) => cell.text());
    expect(headers.some((text) => text.startsWith('Code / barcode'))).toBe(false);
    expect(headers.some((text) => text.startsWith('Reorder at'))).toBe(false);
  });

  // §5.5: stock and its value are daily-use columns, and they come from the
  // read model — the page must not sum or guess them.
  it('shows stock and stock value from the server’s own figures', async () => {
    const wrapper = await mountLoaded();

    const headers = wrapper.findAll('thead th').map((cell) => cell.text());
    expect(headers.some((text) => text.startsWith('Stock'))).toBe(true);
    expect(headers.some((text) => text.startsWith('Stock value'))).toBe(true);
    expect(wrapper.text()).toContain('48.000');
    expect(wrapper.text()).toContain('৳4,800.00');
  });

  it("shows the server's own code and message on failure (UI-28)", async () => {
    load.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'Permission required', 403));

    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('PERMISSION_DENIED');
    expect(wrapper.text()).toContain('Permission required');
    expect(wrapper.text()).not.toContain('Something went wrong');
  });

  it('uses the page for the product list instead of redundant summary cards', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.find('.tiles').exists()).toBe(false);
    expect(wrapper.find('.table-wrap').exists()).toBe(true);
    expect(wrapper.find('.paging').text()).toContain('Showing 1 of 1');
  });

  // §5.5: one `⋯` menu per row carries every per-product action, so the
  // shopkeeper never leaves the list to do them.
  it('offers Edit, Stock, Lots and Deactivate on the row menu', async () => {
    const wrapper = await mountLoaded();

    expect(await rowMenuLabels(wrapper)).toStrictEqual([
      'Edit',
      'Stock',
      'Lots',
      'Deactivate',
    ]);
  });

  // §3.6: a product with stock history can only be deactivated, so offering
  // Delete would be offering an action the server always refuses.
  it('hides Delete for a product that has stock history', async () => {
    const wrapper = await mountLoaded();

    expect(await rowMenuLabels(wrapper)).not.toContain('Delete');
  });

  it('offers Delete only for a product that has never been stocked', async () => {
    load.mockResolvedValue({
      data: [{ ...COLA, hasStockHistory: false, stockQty: 0, stockStatus: 'ZERO_STOCK' }],
      page: { nextCursor: null, hasMore: false },
      summary: SUMMARY,
    });
    const wrapper = await mountLoaded();

    expect(await rowMenuLabels(wrapper)).toContain('Delete');
  });

  it('opens the stock adjustment dialog from the row menu, over the list', async () => {
    const wrapper = await mountLoaded();

    await wrapper.get('.row-menu-trigger').trigger('click');
    await flushPromises();
    const stock = wrapper.findAll('.p-menu-item-link').find((item) => item.text().includes('Stock'));
    await stock?.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Adjust stock');
    expect(wrapper.text()).toContain('In stock now: 48.000 Piece');
    // UI-64: the list is still behind the dialog, not navigated away from.
    expect(push).not.toHaveBeenCalled();
  });

  it('deactivates through a confirmation that names the consequence (UI-26)', async () => {
    setStatus.mockResolvedValue({ ...COLA, status: 'INACTIVE' });
    const wrapper = await mountLoaded();

    await wrapper.get('.row-menu-trigger').trigger('click');
    await flushPromises();
    const deactivate = wrapper
      .findAll('.p-menu-item-link')
      .find((item) => item.text().includes('Deactivate'));
    await deactivate?.trigger('click');
    await flushPromises();

    expect(wrapper.text()).toContain('Deactivate Coca Cola 500ml?');
    expect(wrapper.text()).toContain('Everything already recorded about it stays');

    await wrapper.find('[role="dialog"] .btn-danger').trigger('click');
    await flushPromises();

    expect(setStatus).toHaveBeenCalledWith('test-access', COLA.id, 'INACTIVE');
  });

  it('asks the server again when a filter changes, never filtering in the browser', async () => {
    const wrapper = await mountLoaded();
    load.mockClear();

    await wrapper.find('#filter-status').trigger('click');
    const inactive = wrapper
      .findAll('[role="option"]')
      .find((option) => option.text() === 'Inactive only');
    await inactive?.trigger('mousedown');
    await flushPromises();

    expect(load).toHaveBeenCalledWith('test-access', expect.objectContaining({ status: 'INACTIVE' }));
  });

  it('renders the list filters with PrimeVue Select controls', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.find('#filter-brand').attributes('role')).toBe('combobox');
    expect(wrapper.find('#filter-category').attributes('role')).toBe('combobox');
    expect(wrapper.find('#filter-status').attributes('role')).toBe('combobox');
    expect(wrapper.findAll('select')).toHaveLength(0);
  });
});

/**
 * UI-40 / R-E8: cost is its own permission, and the fields are not sent at all.
 * The screen must not draw a column for a figure it will never receive.
 */
describe('ProductsPage without inventory.cost.view', () => {
  beforeEach(() => {
    useSession().setPermissions(['catalog.product.view']);
    load.mockResolvedValue({
      // Exactly what the server sends such a caller: no `purchasePriceMinor`
      // and no `stockValueMinor` key. Quantity is not a cost, and stays.
      data: [{ ...COLA, purchasePriceMinor: undefined, stockValueMinor: undefined }],
      page: { nextCursor: null, hasMore: false },
      summary: SUMMARY,
    });
  });

  it('shows no purchase or stock-value column and says why', async () => {
    const wrapper = await mountLoaded();

    const headers = wrapper.findAll('thead th').map((cell) => cell.text());
    // Headers now carry Bangla helper text beneath the English label (UI-16),
    // so the cell text is 'Selling বিক্রয় দর' rather than 'Selling'.
    expect(headers.some((text) => text.startsWith('Selling'))).toBe(true);
    expect(headers.some((text) => text.startsWith('Purchase'))).toBe(false);
    expect(headers.some((text) => text.startsWith('Stock value'))).toBe(false);
    // Quantity is not a cost figure, so it stays.
    expect(wrapper.text()).toContain('48.000');
    expect(wrapper.text()).toContain('not sent to this screen at all');
  });

  it('offers no Add, and a row menu with nothing on it', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.find('.page-actions button').exists()).toBe(false);
    expect(await rowMenuLabels(wrapper)).toHaveLength(0);
  });
});
