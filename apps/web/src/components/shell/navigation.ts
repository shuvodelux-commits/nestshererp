export interface SherNavigationItem {
  readonly label: string;
  readonly icon: string;
  readonly to: string;
  readonly needs: string | null;
}

/** One ordered source for desktop, tablet drawer and phone bottom navigation. */
export const SHER_NAVIGATION: readonly SherNavigationItem[] = [
  { label: 'Dashboard', icon: 'pi-home', to: '/dashboard', needs: null },
  { label: 'Products', icon: 'pi-box', to: '/products', needs: 'catalog.product.view' },
  { label: 'Catalog setup', icon: 'pi-sitemap', to: '/catalog', needs: 'catalog.product.view' },
  {
    label: 'Customers & Suppliers',
    icon: 'pi-id-card',
    to: '/parties',
    needs: 'party.customer.view',
  },
  { label: 'Users', icon: 'pi-users', to: '/users', needs: 'user.account.view' },
  { label: 'Roles & Permissions', icon: 'pi-shield', to: '/roles', needs: 'user.role.view' },
  { label: 'Settings', icon: 'pi-cog', to: '/settings', needs: 'settings.setting.view' },
  { label: 'Audit trail', icon: 'pi-history', to: '/audit', needs: 'audit.event.view' },
  { label: 'Security', icon: 'pi-lock', to: '/settings/security', needs: null },
];
