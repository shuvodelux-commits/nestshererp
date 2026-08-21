import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { useSession } from '../src/auth/session';
import AppSidebar from '../src/components/shell/AppSidebar.vue';
import ModuleFeatureNav from '../src/components/shell/ModuleFeatureNav.vue';

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe(): void { /* jsdom has no layout to observe */ }
    unobserve(): void { /* jsdom has no layout to observe */ }
    disconnect(): void { /* jsdom has no layout to observe */ }
  });
});

afterAll(() => vi.unstubAllGlobals());

const routes = [
  '/dashboard', '/products', '/catalog', '/inventory-report', '/parties', '/users', '/roles', '/audit', '/settings', '/settings/security',
].map((path) => ({ path, component: { template: '<div />' } }));

async function routerAt(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  await router.isReady();
  return router;
}

function grantAll(): void {
  const session = useSession();
  session.signIn({ accessToken: 'test-access', refreshToken: 'test-refresh' }, 'karim');
  session.setPermissions([
    'catalog.product.view', 'inventory.lot.view', 'inventory.cost.view',
    'party.customer.view', 'party.supplier.view', 'party.vendor.view',
    'user.account.view', 'user.role.view', 'audit.event.view', 'settings.setting.view',
  ]);
}

afterEach(() => {
  useSession().clear();
});

describe('categorized module navigation', () => {
  it('renders Category → Subcategory only and keeps unbuilt categories absent', async () => {
    grantAll();
    const router = await routerAt('/inventory-report');
    const wrapper = mount(AppSidebar, {
      props: { collapsed: false, drawerVisible: false },
      global: { plugins: [router], directives: { tooltip: () => undefined } },
    });
    await flushPromises();

    // Short names (owner decision 2026-08-20): the caption already says
    // Inventory, so the rows under it are "Products" and "Reports", not
    // "Product Management" and "Inventory Report" said twice over.
    expect(wrapper.text()).toContain('Inventory');
    expect(wrapper.text()).toContain('Products');
    expect(wrapper.text()).toContain('Reports');
    expect(wrapper.text()).not.toContain('Sales Invoice');
    expect(wrapper.text()).not.toContain('Journal Entries');
  });

  it('shows related existing pages contextually instead of as a third sidebar level', async () => {
    grantAll();
    const router = await routerAt('/roles');
    const wrapper = mount(ModuleFeatureNav, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.text()).toContain('Users');
    expect(wrapper.text()).toContain('Roles & Permissions');
    expect(wrapper.text()).not.toContain('Audit Log');
  });

  it('opens Customers under Parties without duplicate page navigation', async () => {
    grantAll();
    const router = await routerAt('/parties?role=CUSTOMER');
    const sidebar = mount(AppSidebar, {
      props: { collapsed: false, drawerVisible: false },
      global: { plugins: [router], directives: { tooltip: () => undefined } },
    });
    const top = mount(ModuleFeatureNav, { global: { plugins: [router] } });
    await flushPromises();

    expect(sidebar.text()).toContain('Parties');
    expect(sidebar.text()).toContain('Customers');
    expect(sidebar.text()).toContain('Suppliers');
    expect(top.find('.feature-nav').exists()).toBe(false);
    expect(top.text()).not.toContain('Customer Ledger');
  });

  /**
   * The tab is named after the page it opens. Stock adjustment and lots are row
   * actions on Products, so naming the tab after all three produced "Products &
   * Stock Adjustment & Lots/Batch" — a label wider than the control holding it.
   */
  it('names a feature tab after its page, not after everything reachable from it', async () => {
    grantAll();
    const router = await routerAt('/products');
    const wrapper = mount(ModuleFeatureNav, { global: { plugins: [router] } });
    await flushPromises();

    const labels = wrapper.findAll('.feature-label').map((item) => item.text());
    expect(labels).toEqual(['Products', 'Catalog Setup']);
    expect(wrapper.text()).not.toContain('Stock Adjustment &');

    // The capabilities are not lost — they are the tab's hover text.
    expect(wrapper.find('.p-tab')?.attributes('title')).toContain('Lots/Batch');
  });

  it('omits a redundant feature strip when all capabilities share one hub route', async () => {
    grantAll();
    const router = await routerAt('/inventory-report');
    const wrapper = mount(ModuleFeatureNav, { global: { plugins: [router] } });
    await flushPromises();
    expect(wrapper.find('.feature-nav').exists()).toBe(false);
  });

  it('highlights only the most specific settings route', async () => {
    grantAll();
    const router = await routerAt('/settings/security');
    const wrapper = mount(AppSidebar, {
      props: { collapsed: false, drawerVisible: false },
      global: { plugins: [router], directives: { tooltip: () => undefined } },
    });
    await flushPromises();

    expect(wrapper.findAll('.nav-item.is-current').map((item) => item.text())).toEqual(['Security']);
    expect(wrapper.findAll('.module-menu .nav-item').every((item) => item.attributes('title') === undefined)).toBe(true);
  });

  /**
   * The accordion is gone: standing on the Dashboard, every page of every
   * category the caller may open is already a link on screen, and the category
   * caption above them is a caption — no click, no expand, nothing to remember
   * between visits.
   */
  it('lists every accessible page without an expand step', async () => {
    grantAll();
    const router = await routerAt('/dashboard');
    const wrapper = mount(AppSidebar, {
      props: { collapsed: false, drawerVisible: false },
      global: { plugins: [router], directives: { tooltip: () => undefined } },
    });
    await flushPromises();

    const targets = wrapper.findAll('.module-menu .nav-item').map((item) => item.attributes('href'));
    expect(targets).toContain('/parties?role=CUSTOMER');
    expect(targets).toContain('/parties?role=SUPPLIER');
    expect(targets).toContain('/products');
    expect(targets).toContain('/settings/security');

    const caption = wrapper.findAll('.nav-section').find((item) => item.text().includes('Parties'));
    expect(caption?.element.tagName).toBe('P');
  });
});
