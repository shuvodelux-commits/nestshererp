/*
 * Coverage claims, read by `pnpm test:inventory` (owner request 2026-09-03).
 *
 * These are what this file is answerable for in the test matrix. A claim naming
 * something the inventory no longer contains fails the scan, so a screen renamed
 * out from under a test cannot leave the coverage report quietly overstating itself.
 *
 * @covers screen:catalog
 */
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Type-only, so it is erased before `vi.mock` hoisting runs.
import type * as CatalogApi from '../src/api/catalog';
import { ApiError } from '../src/api/client';
import { useSession } from '../src/auth/session';
import CatalogPage from '../src/pages/CatalogPage.vue';

/**
 * UI-44: one workflow smoke test — renders, loading, error, and the
 * permission-hidden case. Whether a name is a duplicate or a category may be
 * nested is the server's decision and is tested there.
 */
const load = vi.fn();
const create = vi.fn();
const rename = vi.fn();
const remove = vi.fn();

// The calls are stubbed, but `EMPTY_CATALOG` is real — a hand-written copy of it
// here would be a second definition of "what a screen holds before data arrives".
vi.mock('../src/api/catalog', async () => {
  const actual = await vi.importActual<typeof CatalogApi>('../src/api/catalog');
  return {
    ...actual,
    fetchCatalog: (token: string) => load(token),
    createCatalogEntry: (token: string, kind: string, payload: unknown) =>
      create(token, kind, payload),
    renameCatalogEntry: (token: string, kind: string, id: string, name: string) =>
      rename(token, kind, id, name),
    removeCatalogEntry: (token: string, kind: string, id: string) => remove(token, kind, id),
  };
});

vi.mock('../src/components/shell/AppShell.vue', () => ({
  default: {
    name: 'AppShell',
    template: '<div><div class="page-actions"><slot name="actions" /></div><slot /></div>',
  },
}));

const DRINKS = { id: '01CATDRINKSAAAAAAAAAAAAAAA', name: 'Drinks', parentId: null };
const JUICE = { id: '01CATJUICEAAAAAAAAAAAAAAAA', name: 'Juice', parentId: DRINKS.id };

const FEATURES = {
  productOffers: true,
  expiryTracking: false,
  serialTracking: false,
  customerGroups: false,
  vendors: false,
};

const CATALOG = {
  features: FEATURES,
  units: [
    { id: '01UNITPIECEAAAAAAAAAAAAAAA', name: 'Piece' },
    { id: '01UNITCARTONAAAAAAAAAAAAAA', name: 'Carton' },
  ],
  brands: [{ id: '01BRANDPRANAAAAAAAAAAAAAAA', name: 'Pran' }],
  categories: [DRINKS, JUICE],
};

beforeEach(() => {
  const session = useSession();
  session.signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  session.setPermissions([
    'catalog.product.view',
    'catalog.unit.manage',
    'catalog.brand.manage',
    'catalog.category.manage',
  ]);
  load.mockReset();
  create.mockReset();
  rename.mockReset();
  remove.mockReset();
  load.mockResolvedValue(CATALOG);
});

afterEach(() => {
  useSession().clear();
});

async function mountLoaded() {
  const wrapper = mount(CatalogPage);
  await flushPromises();
  return wrapper;
}

describe('CatalogPage', () => {
  it('shows a skeleton until the catalog arrives (UI-27)', () => {
    load.mockReturnValue(new Promise(() => undefined));

    const wrapper = mount(CatalogPage);

    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
  });

  it('opens on the units list', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('Piece');
    expect(wrapper.text()).toContain('Carton');
    expect(wrapper.text()).toContain('Units of measure');
  });

  it("shows the server's own code and message on failure (UI-28)", async () => {
    load.mockRejectedValue(new ApiError('PERMISSION_DENIED', 'Permission required', 403));

    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('PERMISSION_DENIED');
    expect(wrapper.text()).toContain('Permission required');
    expect(wrapper.text()).not.toContain('Something went wrong');
  });

  it('adds a brand and shows what came back', async () => {
    create.mockResolvedValue({
      ...CATALOG,
      brands: [...CATALOG.brands, { id: '01BRANDACIAAAAAAAAAAAAAAAA', name: 'ACI' }],
    });
    const wrapper = await mountLoaded();

    await wrapper.findAll('.tab')[1]!.trigger('click');
    await wrapper.find('.page-actions button').trigger('click');
    await wrapper.find('#catalog-name').setValue('ACI');
    await wrapper.find('[role="dialog"] form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledWith('test-access', 'brands', { name: 'ACI' });
    expect(wrapper.text()).toContain('ACI');
  });

  it('adds a subcategory under the category it was opened from', async () => {
    create.mockResolvedValue(CATALOG);
    const wrapper = await mountLoaded();

    await wrapper.findAll('.tab')[2]!.trigger('click');
    // The first action on the Drinks row is "Add subcategory".
    const drinksRow = wrapper.findAll('.tree-row')[0]!;
    expect(drinksRow.findAll('.linkish')[0]!.text()).toBe('Add subcategory');
    await drinksRow.findAll('.linkish')[0]!.trigger('click');

    expect(wrapper.text()).toContain('Add a subcategory inside Drinks');

    await wrapper.find('#catalog-name').setValue('Water');
    await wrapper.find('[role="dialog"] form').trigger('submit');
    await flushPromises();

    expect(create).toHaveBeenCalledWith('test-access', 'categories', {
      name: 'Water',
      parentId: DRINKS.id,
    });
  });

  it('says which of the two things removal did', async () => {
    remove.mockResolvedValue({ outcome: 'ARCHIVED' });
    const wrapper = await mountLoaded();

    await wrapper.findAll('.tab')[1]!.trigger('click');
    await wrapper.find('.actions .danger').trigger('click');
    await wrapper.find('[role="dialog"] .btn-danger').trigger('click');
    await flushPromises();

    expect(remove).toHaveBeenCalledWith('test-access', 'brands', CATALOG.brands[0]!.id);
    expect(wrapper.text()).toContain('no longer offered for new products');
  });
});

/**
 * UI-09: "Never render a control that will 403." Each list has its own
 * permission, so a caller may read all three while being offered nothing.
 */
describe('CatalogPage for someone who may look but not change', () => {
  beforeEach(() => {
    useSession().setPermissions(['catalog.product.view']);
  });

  it('still shows every list', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.text()).toContain('Piece');
  });

  it('offers no Add, no Rename and no Remove, and says why', async () => {
    const wrapper = await mountLoaded();

    expect(wrapper.find('.page-actions button').exists()).toBe(false);
    expect(wrapper.findAll('.linkish')).toHaveLength(0);
    expect(wrapper.text()).toContain('not change it');
  });
});
