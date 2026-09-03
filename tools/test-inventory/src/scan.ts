import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

import type { EndpointItem, Inventory, PermissionItem, ScreenItem, WorkflowItem } from './model.js';
import {
  actions,
  apiCalls,
  dropdowns,
  fields,
  opensDialogs,
  permissionsUsed,
  hasTabs,
  splitSfc,
  tables,
  validationMessages,
} from './sfc.js';

export function walk(dir: string, match: (path: string) => boolean): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path, match));
    else if (match(path)) out.push(path);
  }
  return out.sort();
}

/**
 * Route path and route name for every screen, read from `router.ts` itself.
 *
 * Read rather than restated: a second list of routes in a test tool is a list
 * that goes stale the first week, and a screen missing from the matrix because
 * somebody added a route and not an inventory entry is the exact failure the
 * owner asked to be made impossible ("nothing should silently remain untested").
 */
function routesOf(root: string): Map<string, { path: string; name: string }> {
  const source = readFileSync(join(root, 'apps/web/src/router.ts'), 'utf8');
  const out = new Map<string, { path: string; name: string }>();
  const pattern =
    /path:\s*'([^']+)'\s*,\s*name:\s*'([^']+)'\s*,\s*component:\s*\(\)\s*=>\s*import\('\.\/pages\/([\w]+)\.vue'\)/g;
  for (const match of source.matchAll(pattern)) {
    const [, path, name, component] = match;
    if (path === undefined || name === undefined || component === undefined) continue;
    // First wins: `/finance/ledger` is the menu entry and the `:id` form is the
    // same page arrived at differently, and the matrix wants the one a person
    // reaches from navigation.
    if (!out.has(component)) out.set(component, { path, name });
  }
  return out;
}

/**
 * Route → the permissions the sidebar requires before it will draw the entry.
 *
 * This is one half of §11's proof and the weaker half: a hidden menu is not
 * security, and the matrix says so by carrying the endpoint permissions beside
 * it. What this list is genuinely good for is knowing which role should be able
 * to reach a screen at all, which is what a permission test iterates.
 */
function navPermissionsOf(root: string): Map<string, readonly string[]> {
  const source = readFileSync(join(root, 'apps/web/src/components/shell/navigation.ts'), 'utf8');
  const out = new Map<string, readonly string[]>();
  const pattern = /feature\(\s*'([^']+)'[\s\S]{0,400}?'(\/[^']*)'\s*(?:,\s*\[([\s\S]*?)\])?/g;
  for (const match of source.matchAll(pattern)) {
    const route = (match[2] ?? '').split('?')[0] ?? '';
    const codes = [...(match[3] ?? '').matchAll(/'([a-z0-9._]+)'/g)].map((code) => code[1] ?? '');
    if (route !== '' && !out.has(route)) out.set(route, codes);
  }
  return out;
}

/**
 * The screens a shopkeeper uses standing at the counter, on a phone.
 *
 * Derived from where a screen sits in navigation rather than listed by hand:
 * the daily, sales and purchasing modules are the ones worked during a shift,
 * and §12's layout guards are owed to exactly those. Settings and reports are
 * desktop work — a person configuring a till or reading a month is sitting down
 * — and a layout guard on them would be effort spent proving something nobody
 * does.
 */
const MOBILE_MODULES = ['daily', 'sales', 'purchasing', 'inventory'];

function mobileModulesOf(root: string): ReadonlySet<string> {
  const source = readFileSync(join(root, 'apps/web/src/components/shell/navigation.ts'), 'utf8');
  const routes = new Set<string>();
  for (const category of MOBILE_MODULES) {
    const block = new RegExp(`id: '${category}', label:[\\s\\S]*?(?=\\n  \\{\\n|\\n\\];)`).exec(
      source,
    );
    for (const match of (block?.[0] ?? '').matchAll(/'(\/[a-z0-9\-/]*)'/g)) {
      routes.add(match[1] ?? '');
    }
  }
  return routes;
}

function screenId(file: string): string {
  return basename(file, '.vue')
    .replace(/(Page|Dialog|Drawer)$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

function kindOf(file: string): ScreenItem['kind'] {
  if (file.includes('/pages/')) return 'PAGE';
  if (file.endsWith('Dialog.vue')) return 'DIALOG';
  if (file.endsWith('Drawer.vue')) return 'DRAWER';
  return 'COMPONENT';
}

/**
 * Components that hold no business screen of their own.
 *
 * Excluded from the matrix because counting them would inflate every coverage
 * figure with things that have no fields, no actions and no business effect —
 * and a coverage report that flatters itself is worse than none. They are
 * covered where they are used, and several have component tests already.
 */
const NOT_A_SCREEN = new Set([
  'AppCard', 'EmptyState', 'ErrorNotice', 'HelpTip', 'StatCard', 'SortableHeader',
  'GoogleButton', 'DayStatusChip', 'OfflineStatusChip', 'SyncStatusChip', 'OfflineBar',
  'AppUpdateBar', 'LicenseNotice', 'ProviderSupportNotice', 'InvoiceDocument',
  'SupplierOrderPrint', 'AppShell', 'AppLayout', 'AppSidebar', 'AppSidebarNav',
  'AppBottomNav', 'AppTopBar', 'ModuleFeatureNav',
]);

export function scanScreens(root: string): readonly ScreenItem[] {
  const routes = routesOf(root);
  const navPermissions = navPermissionsOf(root);
  const mobileRoutes = mobileModulesOf(root);
  const files = [
    ...walk(join(root, 'apps/web/src/pages'), (path) => path.endsWith('.vue')),
    ...walk(join(root, 'apps/web/src/components'), (path) => path.endsWith('.vue')),
  ];

  const out: ScreenItem[] = [];
  for (const file of files) {
    const name = basename(file, '.vue');
    if (NOT_A_SCREEN.has(name)) continue;
    const source = readFileSync(file, 'utf8');
    const { script, template } = splitSfc(source);
    const route = routes.get(name) ?? null;
    const screenFields = fields(template, script);

    out.push({
      id: `${kindOf(file) === 'PAGE' ? 'screen' : 'dialog'}:${screenId(file)}`,
      name,
      file: relative(root, file),
      kind: kindOf(file),
      route: route?.path ?? null,
      routeName: route?.name ?? null,
      navPermissions: route === null ? [] : navPermissions.get(route.path) ?? [],
      permissionsUsed: permissionsUsed(source),
      fields: screenFields,
      dropdowns: dropdowns(template, script, screenFields),
      actions: actions(template),
      dialogs: opensDialogs(template),
      tables: tables(template),
      hasSearch: /<SearchField|type="search"/.test(template),
      hasFilters: /class="[^"]*filter|\bfilters\b|statusFilter|const status = ref/.test(
        `${template}${script}`,
      ),
      hasTabs: hasTabs(template),
      validationMessages: validationMessages(script),
      apiCalls: apiCalls(script),
      mobileRelevant: route !== null && mobileRoutes.has(route.path),
    });
  }
  return out;
}

/**
 * Every HTTP endpoint, with the permission its use case demands.
 *
 * The permission is read from the service rather than the controller because
 * this codebase enforces access in the use case — `accessControl.require(...)`
 * — and a controller decorator would be the wrong place to look. The mapping is
 * per module directory: a controller in `src/sales` is answered by services in
 * `core-application/src/sales`, and the codes those services require are the
 * codes that endpoint can refuse with. It is a module-level answer rather than
 * a per-method one, which is honest about what static reading can prove and is
 * why §11's permission tests call the endpoints for real.
 */
export function scanEndpoints(root: string): readonly EndpointItem[] {
  const files = walk(join(root, 'apps/api/src'), (path) => path.endsWith('.controller.ts'));
  const out: EndpointItem[] = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const base = /@Controller\('([^']*)'\)/.exec(source)?.[1] ?? '';
    const controller = /export class (\w+)/.exec(source)?.[1] ?? basename(file);
    const module = relative(join(root, 'apps/api/src'), file).split('/')[0] ?? '';
    const permissions = permissionsOfModule(root, module);

    for (const match of source.matchAll(/@(Get|Post|Put|Patch|Delete)\(\s*'?([^')]*)'?\s*\)/g)) {
      const method = (match[1] ?? '').toUpperCase();
      const suffix = (match[2] ?? '').trim();
      const path = `/${[base, suffix].filter((part) => part !== '').join('/')}`;
      out.push({
        id: `endpoint:${method} ${path}`,
        method,
        path,
        controller,
        file: relative(root, file),
        permissions,
      });
    }
  }
  return out;
}

const moduleCache = new Map<string, readonly string[]>();

function permissionsOfModule(root: string, module: string): readonly string[] {
  const cached = moduleCache.get(module);
  if (cached !== undefined) return cached;

  const dir = join(root, 'packages/core-application/src', module);
  let codes: readonly string[] = [];
  try {
    const constants = new Set<string>();
    for (const file of walk(dir, (path) => path.endsWith('.ts'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/Permission\.([A-Z0-9_]+)/g)) {
        const constant = match[1];
        if (constant !== undefined) constants.add(constant);
      }
    }
    codes = [...constants].sort();
  } catch {
    // A controller with no matching use-case directory — health, for one, which
    // answers before anybody is signed in and requires nothing.
    codes = [];
  }
  moduleCache.set(module, codes);
  return codes;
}

/** Every permission code the product defines (§5.26). */
export function scanPermissions(root: string): readonly PermissionItem[] {
  const source = readFileSync(join(root, 'packages/core-contracts/src/permissions.ts'), 'utf8');
  const out: PermissionItem[] = [];
  for (const match of source.matchAll(/^ {2}([A-Z0-9_]+):\s*'([a-z0-9._]+)',$/gm)) {
    const constant = match[1] ?? '';
    const code = match[2] ?? '';
    out.push({ code, constant, module: code.split('.')[0] ?? '' });
  }
  return out;
}

/**
 * The cross-module journeys a real shop performs (§10).
 *
 * Listed here rather than derived, because a workflow is a business fact and
 * not a property of the code: nothing in the source says that a trading day
 * runs open → buy → sell → collect → spend → reconcile → close. This is the
 * list the owner named, and it is the one thing in this inventory that a person
 * maintains on purpose.
 */
export const WORKFLOWS: readonly WorkflowItem[] = [
  { id: 'workflow:trading-day', name: 'Manager trading day', steps: ['login', 'open day', 'purchase', 'stock check', 'POS sale', 'customer due', 'receive payment', 'expense', 'daybook', 'daily cash', 'close day'] },
  { id: 'workflow:cash-sale', name: 'Cash sale at the counter', steps: ['open day', 'POS sale paid in full', 'stock falls', 'cash rises'] },
  { id: 'workflow:credit-sale', name: 'Credit sale and collection', steps: ['POS sale on account', 'customer due rises', 'receive payment', 'due clears'] },
  { id: 'workflow:supplier-payment', name: 'Purchase and supplier payment', steps: ['purchase on credit', 'payable rises', 'pay supplier', 'payable clears'] },
  { id: 'workflow:purchase-return', name: 'Purchase return', steps: ['purchase', 'return to supplier', 'stock falls', 'payable falls'] },
  { id: 'workflow:sales-return', name: 'Sales return', steps: ['sale', 'return from customer', 'stock rises', 'refund or credit'] },
  { id: 'workflow:correction', name: 'Correction of a posted document', steps: ['post document', 'correct it', 'audit history preserved'] },
  { id: 'workflow:void', name: 'Void or cancel', steps: ['post document', 'cancel it', 'no financial effect remains'] },
  { id: 'workflow:stock-count', name: 'Stock count', steps: ['start count', 'enter counted', 'post variance', 'stock matches'] },
  { id: 'workflow:serial', name: 'Serial-tracked product', steps: ['receive with serials', 'sell one serial', 'serial no longer sellable'] },
  { id: 'workflow:expiry', name: 'Expiry-tracked product', steps: ['receive with expiry', 'expiring report', 'sell oldest first'] },
  { id: 'workflow:vendor-stock', name: 'Vendor stock out and back', steps: ['give products to vendor', 'vendor settles', 'receive back'] },
  { id: 'workflow:transfer', name: 'Money transfer between accounts', steps: ['transfer', 'source falls', 'destination rises', 'no P&L effect'] },
  { id: 'workflow:reconciliation', name: 'Bank reconciliation', steps: ['start', 'import statement', 'match', 'complete'] },
  { id: 'workflow:permissions', name: 'Permission-sensitive action', steps: ['role without code', 'UI hides', 'route refuses', 'API returns 403'] },
  { id: 'workflow:offline', name: 'Offline trading and sync', steps: ['go offline', 'sell', 'come back', 'queue drains'] },
  { id: 'workflow:reports', name: 'Report generation', steps: ['sales report', 'purchase report', 'stock report', 'money report'] },
];

export function buildInventory(root: string): Inventory {
  return {
    generatedFrom: 'pnpm test:inventory — do not edit by hand',
    screens: scanScreens(root),
    endpoints: scanEndpoints(root),
    permissions: scanPermissions(root),
    workflows: WORKFLOWS,
  };
}
