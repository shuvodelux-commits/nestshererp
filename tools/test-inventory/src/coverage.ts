import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import type { Inventory, ScreenItem } from './model.js';
import { walk } from './scan.js';

/**
 * What is actually tested, proved from the test files rather than asserted
 * (owner request 2026-09-03, §17).
 *
 * **A test claims its coverage in its own header and nothing is inferred.** The
 * alternative — matching a spec's filename against a screen's name — reports
 * `products-page.spec.ts` as covering the Products screen whether it asserts
 * anything about it or not, and a coverage report that can be satisfied by
 * naming a file is a report that will be. The claim is a line the author writes
 * on purpose:
 *
 * ```
 *  * @covers screen:products
 *  * @covers field:products/sale-price
 *  * @covers endpoint:POST /api/v1/products
 *  * @covers permission:product.item.create
 *  * @covers workflow:cash-sale
 * ```
 *
 * A claim naming something the inventory does not contain is an error, not a
 * warning: it means a screen was renamed or removed and a test is still
 * claiming it, which is how a report starts flattering itself.
 */

export type Status = 'TESTED' | 'PARTIALLY TESTED' | 'NOT TESTED' | 'NOT APPLICABLE';

export interface Claim {
  readonly target: string;
  readonly file: string;
}

/** Which layer a spec belongs to, read from where it lives (§20). */
export function layerOf(file: string): string {
  if (file.includes('/e2e/')) return file.includes('mobile-') ? 'playwright-mobile' : 'playwright';
  if (file.startsWith('apps/api/')) return 'api-integration';
  if (file.startsWith('apps/web/')) return 'component';
  return 'unit';
}

/**
 * A spec that proves something for *every* permission code rather than one.
 *
 * `permission-matrix.spec.ts` runs the whole role × code grid against the real
 * access control, so listing 117 `@covers` lines in its header would be a
 * hand-kept copy of the catalogue — the one thing in that file able to go stale,
 * and the exact failure the support ceiling suffered. It writes
 * `@covers-all-permissions` instead and the catalogue is expanded here.
 *
 * This is the only wildcard the linker understands, deliberately: a claim should
 * normally name what it covers, and a second wildcard would be the beginning of
 * a coverage report that claims everything.
 */
const ALL_PERMISSIONS_DIRECTIVE = '@covers-all-permissions';

/**
 * The two sweeps, which cover every routed screen rather than a named few.
 *
 * Same argument as the permission matrix: `screen-sweep.spec.ts` reads its
 * route list out of this very inventory at run time, so a header listing them
 * would be a copy of a generated file, stale the moment a route is added — and
 * the sweep would still be testing the new screen while the report said it was
 * untested.
 */
const ALL_ROUTES_DIRECTIVE = '@covers-all-routes';
const ALL_MOBILE_ROUTES_DIRECTIVE = '@covers-all-mobile-routes';

export interface ClaimSources {
  readonly permissionCodes?: readonly string[];
  /** Screen ids with a route, for `@covers-all-routes`. */
  readonly routedScreenIds?: readonly string[];
  readonly mobileScreenIds?: readonly string[];
}

export function readClaims(root: string, sources: ClaimSources = {}): readonly Claim[] {
  const dirs = ['apps', 'packages', 'tools'];
  const out: Claim[] = [];
  for (const dir of dirs) {
    for (const file of walk(join(root, dir), (path) => path.endsWith('.spec.ts'))) {
      const source = readFileSync(file, 'utf8');
      const here = relative(root, file);
      if (source.includes(ALL_PERMISSIONS_DIRECTIVE)) {
        for (const code of sources.permissionCodes ?? []) {
          out.push({ target: `permission:${code}`, file: here });
        }
      }
      if (source.includes(ALL_ROUTES_DIRECTIVE)) {
        for (const id of sources.routedScreenIds ?? []) out.push({ target: id, file: here });
      }
      if (source.includes(ALL_MOBILE_ROUTES_DIRECTIVE)) {
        for (const id of sources.mobileScreenIds ?? []) out.push({ target: id, file: here });
      }
      for (const match of source.matchAll(/@covers\s+([^\n*]+)/g)) {
        const target = (match[1] ?? '').trim();
        // The directive itself is matched by the `@covers` pattern above.
        if (target === '' || target.startsWith('-all-')) continue;
        out.push({ target, file: relative(root, file) });
      }
    }
  }
  return out;
}

/**
 * Things that will never have an automated test, each with the reason.
 *
 * `NOT APPLICABLE` is a claim about the world and needs defending, so it is
 * written here with its justification rather than being a quiet absence. Every
 * entry is something no headless browser can observe: what a printer put on
 * paper, what a real Google account did, what a machine with no network did to
 * its own disk.
 */
export const NOT_APPLICABLE: ReadonlyMap<string, string> = new Map([
  ['screen:google-callback', 'Completes a real Google OAuth redirect; the provider cannot be driven headlessly, and the token exchange behind it is covered by apps/api/test/google-registration.spec.ts.'],
  ['dialog:invoice-preview', 'Renders the invoice for a printer. What reaches paper is a browser print pipeline, not application behaviour; the figures on it are asserted where they are computed.'],
  ['dialog:supplier-order-print', 'Same: a print surface over data proved elsewhere.'],
  ['screen:storage-check', 'The O-6 storage spike measures this physical machine\'s disk and browser quota. Its whole purpose is to report what varies per device, so an assertion about the number would be an assertion about the CI runner.'],
]);

interface ScreenCoverage {
  readonly screen: ScreenItem;
  readonly status: Status;
  readonly layers: readonly string[];
  readonly missing: readonly string[];
  readonly reason: string | null;
}

/**
 * A screen is only `TESTED` when everything on it that can fail is claimed.
 *
 * The bar is deliberately set at the things the owner named: the screen itself,
 * every field it refuses to save without, every dropdown, and every action that
 * writes or destroys something. A screen claimed but with three uncovered
 * dropdowns reports as `PARTIALLY TESTED` and names them, because "mostly
 * tested" is the state most screens are genuinely in and hiding it under a
 * green figure is how untested things stay untested.
 */
export function coverScreen(screen: ScreenItem, claims: readonly Claim[]): ScreenCoverage {
  const reason = NOT_APPLICABLE.get(screen.id) ?? null;
  const mine = claims.filter(
    (claim) => claim.target === screen.id || claim.target.startsWith(`${screen.id}/`),
  );
  const layers = [...new Set(mine.map((claim) => layerOf(claim.file)))].sort();
  if (reason !== null) {
    return { screen, status: 'NOT APPLICABLE', layers, missing: [], reason };
  }

  const claimed = new Set(mine.map((claim) => claim.target));
  const missing: string[] = [];
  if (!claimed.has(screen.id)) missing.push('the screen itself');
  for (const field of screen.fields) {
    if (field.required !== 'NO' && !claimed.has(`${screen.id}/${field.id}`)) {
      missing.push(`required field ${field.id}`);
    }
  }
  for (const dropdown of screen.dropdowns) {
    if (!claimed.has(`${screen.id}/${dropdown.id}`)) missing.push(`dropdown ${dropdown.id}`);
  }
  for (const action of screen.actions) {
    if (action.role !== 'PRIMARY' && action.role !== 'DESTRUCTIVE') continue;
    if (!claimed.has(`${screen.id}/action/${action.label}`)) missing.push(`action ${action.label}`);
  }

  const status: Status =
    mine.length === 0 ? 'NOT TESTED' : missing.length === 0 ? 'TESTED' : 'PARTIALLY TESTED';
  return { screen, status, layers, missing, reason: null };
}

export interface CoverageReport {
  readonly screens: readonly ScreenCoverage[];
  readonly endpoints: ReadonlyMap<string, Status>;
  readonly permissions: ReadonlyMap<string, Status>;
  readonly workflows: ReadonlyMap<string, Status>;
  readonly unknownClaims: readonly Claim[];
}

export function buildCoverage(inventory: Inventory, claims: readonly Claim[]): CoverageReport {
  const screens = inventory.screens.map((screen) => coverScreen(screen, claims));
  const claimed = new Set(claims.map((claim) => claim.target));

  const endpoints = new Map<string, Status>(
    inventory.endpoints.map((endpoint) => [
      endpoint.id,
      claimed.has(endpoint.id) ? 'TESTED' : 'NOT TESTED',
    ]),
  );
  const permissions = new Map<string, Status>(
    inventory.permissions.map((permission) => [
      permission.code,
      claimed.has(`permission:${permission.code}`) ? 'TESTED' : 'NOT TESTED',
    ]),
  );
  const workflows = new Map<string, Status>(
    inventory.workflows.map((workflow) => [
      workflow.id,
      claimed.has(workflow.id) ? 'TESTED' : 'NOT TESTED',
    ]),
  );

  const known = new Set<string>([
    ...inventory.screens.flatMap((screen) => [
      screen.id,
      ...screen.fields.map((field) => `${screen.id}/${field.id}`),
      ...screen.actions.map((action) => `${screen.id}/action/${action.label}`),
    ]),
    ...inventory.endpoints.map((endpoint) => endpoint.id),
    ...inventory.permissions.map((permission) => `permission:${permission.code}`),
    ...inventory.workflows.map((workflow) => workflow.id),
  ]);

  return {
    screens,
    endpoints,
    permissions,
    workflows,
    unknownClaims: claims.filter((claim) => !known.has(claim.target)),
  };
}
