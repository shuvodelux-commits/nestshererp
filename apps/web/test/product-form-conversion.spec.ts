import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only, so it is erased before `vi.mock` hoisting runs.
import type * as CatalogApi from '../src/api/catalog';
import { useSession } from '../src/auth/session';
import ProductFormPage from '../src/pages/ProductFormPage.vue';

/**
 * D-41 — the second unit, and the price switch that goes with it.
 *
 * This is a **money** path, so it gets its own focused test rather than riding
 * on the products smoke test: what the shopkeeper types per Pipe has to leave
 * this screen as a price per Foot, and a mistake here would be a wrong purchase
 * price on every product entered that way.
 *
 * The worked example is the owner's: Base = Feet, Conversion = Pipe,
 * 1 Pipe = 20 Feet. ৳5.25/Foot is ৳105.00/Pipe.
 */
const create = vi.fn();
const catalog = vi.fn();
const push = vi.fn();

const FEET = '01UNITFEETAAAAAAAAAAAAAAAA';
const PIPE = '01UNITPIPEAAAAAAAAAAAAAAAA';

vi.mock('../src/api/products', () => ({
  createProduct: (token: string, payload: unknown, key: string) => create(token, payload, key),
  fetchProduct: vi.fn(),
  updateProduct: vi.fn(),
  deleteProduct: vi.fn(),
  generateProductBarcode: vi.fn(),
}));

vi.mock('../src/api/catalog', async () => {
  const actual = await vi.importActual<typeof CatalogApi>('../src/api/catalog');
  return { ...actual, fetchCatalog: (token: string) => catalog(token) };
});

vi.mock('vue-router', () => ({
  useRouter: () => ({ push }),
  useRoute: () => ({ params: { id: 'new' }, query: {} }),
}));

vi.mock('../src/components/shell/AppShell.vue', () => ({
  default: { name: 'AppShell', template: '<div><slot /></div>' },
}));

beforeEach(() => {
  const session = useSession();
  session.signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  session.setPermissions([
    'catalog.product.view',
    'catalog.product.create',
    'catalog.product.edit',
    'catalog.unit.manage',
  ]);
  create.mockReset();
  catalog.mockReset();
  push.mockReset();
  catalog.mockResolvedValue({
    units: [
      { id: FEET, name: 'Feet' },
      { id: PIPE, name: 'Pipe' },
    ],
    brands: [],
    categories: [],
    features: {
      productOffers: false,
      expiryTracking: false,
      serialTracking: false,
      customerGroups: false,
      vendors: false,
    },
  });
});

afterEach(() => {
  useSession().clear();
});

async function mountForm() {
  const wrapper = mount(ProductFormPage);
  await flushPromises();
  return wrapper;
}

/** Fills in the mandatory §5.5 set with Feet as the base unit. */
async function fillBasics(wrapper: Awaited<ReturnType<typeof mountForm>>) {
  await wrapper.find('#product-name').setValue('PVC pipe 1 inch');
  await wrapper.find('#product-unit').setValue(FEET);
  await wrapper.find('#purchase-price').setValue('4.00');
  await wrapper.find('#selling-price').setValue('5.25');
}

async function enableConversion(wrapper: Awaited<ReturnType<typeof mountForm>>) {
  // The second unit is opt-in: the conversion controls do not exist until the
  // shopkeeper says the product is bought or sold another way.
  await wrapper.find('#has-second-unit').setValue(true);
  await wrapper.find('#conversion-unit').setValue(PIPE);
  await wrapper.find('#conversion-factor').setValue('20');
  await flushPromises();
}

describe('a product with no second unit', () => {
  it('sends no conversion and offers no price switch', async () => {
    const wrapper = await mountForm();
    await fillBasics(wrapper);

    // The toggle is absent entirely — there is no second unit to switch to.
    expect(wrapper.find('.price-unit').exists()).toBe(false);

    create.mockResolvedValue({ id: '01PRODAAAAAAAAAAAAAAAAAAAA' });
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const payload = create.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload['conversionUnitId']).toBeNull();
    expect(payload['conversionFactorQty']).toBeNull();
    expect(payload['sellingPriceMinor']).toBe(525);
  });
});

describe('a product with a second unit (D-41)', () => {
  it('sends the factor as a scale-3 quantity', async () => {
    const wrapper = await mountForm();
    await fillBasics(wrapper);
    await enableConversion(wrapper);

    create.mockResolvedValue({ id: '01PRODAAAAAAAAAAAAAAAAAAAA' });
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const payload = create.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload['conversionUnitId']).toBe(PIPE);
    // 1 Pipe = 20 Feet.
    expect(payload['conversionFactorQty']).toBe(20_000);
  });

  it('shows ৳5.25 per Foot as ৳105.00 per Pipe when the price unit is switched', async () => {
    const wrapper = await mountForm();
    await fillBasics(wrapper);
    await enableConversion(wrapper);

    const [perBase, perConversion] = wrapper.findAll('.price-unit .chip');
    expect(perBase!.text()).toBe('Price is per Feet');
    expect(perConversion!.text()).toBe('Price is per Pipe');

    await perConversion!.trigger('click');

    expect((wrapper.find('#selling-price').element as HTMLInputElement).value).toBe('105.00');
    expect((wrapper.find('#purchase-price').element as HTMLInputElement).value).toBe('80.00');
    expect(wrapper.find('label[for="selling-price"]').text()).toContain('per Pipe');
  });

  it('still sends the price per base unit after switching (D-41)', async () => {
    const wrapper = await mountForm();
    await fillBasics(wrapper);
    await enableConversion(wrapper);

    await wrapper.findAll('.price-unit .chip')[1]!.trigger('click');
    // Now typing in Pipes: ৳120.00 per Pipe over 20 Feet is ৳6.00 per Foot.
    await wrapper.find('#selling-price').setValue('120.00');

    create.mockResolvedValue({ id: '01PRODAAAAAAAAAAAAAAAAAAAA' });
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const payload = create.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload['sellingPriceMinor']).toBe(600);
  });

  it('rounds a per-Pipe price that does not divide evenly, once (D-31)', async () => {
    const wrapper = await mountForm();
    await fillBasics(wrapper);
    await enableConversion(wrapper);

    await wrapper.findAll('.price-unit .chip')[1]!.trigger('click');
    // ৳105.05 per Pipe is ৳5.2525 per Foot; money is stored at two decimals.
    await wrapper.find('#selling-price').setValue('105.05');

    create.mockResolvedValue({ id: '01PRODAAAAAAAAAAAAAAAAAAAA' });
    await wrapper.find('form').trigger('submit');
    await flushPromises();

    const payload = create.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload['sellingPriceMinor']).toBe(525);
  });

  it('reads a reorder level back the way it is counted', async () => {
    const wrapper = await mountForm();
    await fillBasics(wrapper);
    await enableConversion(wrapper);

    // 105 Feet is 5 Pipe + 5 Feet.
    await wrapper.find('#min-stock').setValue('105');
    await flushPromises();

    expect(wrapper.text()).toContain('5.000 Pipe + 5.000 Feet');
  });

  it('refuses half a rule before making the round trip', async () => {
    const wrapper = await mountForm();
    await fillBasics(wrapper);
    await wrapper.find('#has-second-unit').setValue(true);
    await wrapper.find('#conversion-unit').setValue(PIPE);
    await flushPromises();

    await wrapper.find('form').trigger('submit');
    await flushPromises();

    expect(create).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Enter how many Feet one Pipe contains');
  });
});
