import type { Inventory, ScreenItem } from './model.js';
import type { CoverageReport, Status } from './coverage.js';
import { layerOf } from './coverage.js';

/** A cell that will not break the table it sits in. */
function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim() || '—';
}

function list(values: readonly string[], limit = 8): string {
  if (values.length === 0) return '—';
  const shown = values.slice(0, limit).join(', ');
  return values.length > limit ? `${shown} … (+${String(values.length - limit)})` : shown;
}

const BADGE: Record<Status, string> = {
  TESTED: '✅ TESTED',
  'PARTIALLY TESTED': '🟡 PARTIALLY TESTED',
  'NOT TESTED': '❌ NOT TESTED',
  'NOT APPLICABLE': '⬜ NOT APPLICABLE',
};

function screenSection(screen: ScreenItem, report: CoverageReport): string {
  const cover = report.screens.find((entry) => entry.screen.id === screen.id);
  const status = cover?.status ?? 'NOT TESTED';
  const required = screen.fields.filter((field) => field.required !== 'NO');
  const optional = screen.fields.filter((field) => field.required === 'NO');

  const rows: Array<[string, string]> = [
    ['Screen', screen.name],
    ['Id', `\`${screen.id}\``],
    ['File', `\`${screen.file}\``],
    ['Kind', screen.kind],
    ['Route', screen.route === null ? 'opened from its parent screen' : `\`${screen.route}\``],
    ['Roles', list(screen.navPermissions.length > 0 ? screen.navPermissions : screen.permissionsUsed)],
    ['Fields', list(screen.fields.map((field) => `${field.id} (${field.kind})${field.labelled ? '' : ' ⚠ no accessible name'}`), 20)],
    ['Required fields', list(required.map((field) => `${field.id}${field.required === 'CONDITIONAL' ? ' (conditional)' : ''}`))],
    ['Optional fields', list(optional.map((field) => field.id), 20)],
    ['Dropdowns', list(screen.dropdowns.map((drop) => `${drop.id}${drop.searchable ? ' (searchable)' : ''}${drop.dependsOn.length > 0 ? ` ← ${drop.dependsOn.join('+')}` : ''}`))],
    ['Primary action', list(screen.actions.filter((action) => action.role === 'PRIMARY').map((action) => action.label))],
    ['Secondary actions', list(screen.actions.filter((action) => action.role === 'SECONDARY').map((action) => action.label))],
    ['Row actions', list(screen.actions.filter((action) => action.role === 'ROW').map((action) => action.label))],
    ['Destructive actions', list(screen.actions.filter((action) => action.role === 'DESTRUCTIVE').map((action) => action.label))],
    ['Opens', list(screen.dialogs)],
    ['Tables', screen.tables.length === 0 ? '—' : screen.tables.map((table) => `${String(table.columns.length)} columns${table.sortable ? ', sortable' : ''}${table.paginated ? ', paginated' : ''}${table.hasEmptyState ? ', empty state' : ''}`).join('; ')],
    ['Search / filters / tabs', `${screen.hasSearch ? 'search' : '—'} / ${screen.hasFilters ? 'filters' : '—'} / ${screen.hasTabs ? 'tabs' : '—'}`],
    ['Validation rules', list(screen.validationMessages, 6)],
    ['Business effects', list(screen.apiCalls, 12)],
    ['Permissions', list(screen.permissionsUsed)],
    ['Desktop / mobile', screen.mobileRelevant ? 'desktop + mobile layout guard' : 'desktop'],
    ['Responsible tests', list(cover?.layers ?? [])],
    ['Status', BADGE[status]],
    ['Gaps', cover?.reason ?? list(cover?.missing ?? ['not yet claimed by any test'], 10)],
  ];

  return [
    `### ${screen.name}`,
    '',
    '| | |',
    '| --- | --- |',
    ...rows.map(([key, value]) => `| **${key}** | ${cell(value)} |`),
    '',
  ].join('\n');
}

export function renderMatrix(inventory: Inventory, report: CoverageReport): string {
  const pages = inventory.screens.filter((screen) => screen.kind === 'PAGE');
  const dialogs = inventory.screens.filter((screen) => screen.kind !== 'PAGE');
  const statusOf = (id: string): Status =>
    report.screens.find((entry) => entry.screen.id === id)?.status ?? 'NOT TESTED';

  return [
    '# ERP Test Matrix',
    '',
    '> **Generated — do not edit by hand.** Run `pnpm test:inventory`. Every figure below is',
    '> read out of the source: the routes from `apps/web/src/router.ts`, the permissions each',
    '> screen draws itself from, the endpoints from the controllers, and the coverage from the',
    '> `@covers` lines the tests themselves carry. A screen added without a test appears here',
    '> as `NOT TESTED` on the next run, which is the point — nothing silently stays untested.',
    '',
    '## What this counts',
    '',
    '| | Total |',
    '| --- | ---: |',
    `| Pages (routed screens) | ${String(pages.length)} |`,
    `| Dialogs, drawers and forms | ${String(dialogs.length)} |`,
    `| Fields | ${String(inventory.screens.reduce((sum, screen) => sum + screen.fields.length, 0))} |`,
    `| Required fields | ${String(inventory.screens.reduce((sum, screen) => sum + screen.fields.filter((field) => field.required !== 'NO').length, 0))} |`,
    `| Dropdowns | ${String(inventory.screens.reduce((sum, screen) => sum + screen.dropdowns.length, 0))} |`,
    `| Buttons and row actions | ${String(inventory.screens.reduce((sum, screen) => sum + screen.actions.length, 0))} |`,
    `| Tables | ${String(inventory.screens.reduce((sum, screen) => sum + screen.tables.length, 0))} |`,
    `| HTTP endpoints | ${String(inventory.endpoints.length)} |`,
    `| Permission codes | ${String(inventory.permissions.length)} |`,
    `| Cross-module workflows | ${String(inventory.workflows.length)} |`,
    '',
    '## Screens at a glance',
    '',
    '| Screen | Route | Fields | Dropdowns | Actions | Mobile | Status |',
    '| --- | --- | ---: | ---: | ---: | :---: | --- |',
    ...inventory.screens.map((screen) =>
      `| ${cell(screen.name)} | ${screen.route === null ? '_(dialog)_' : `\`${screen.route}\``} | ${String(screen.fields.length)} | ${String(screen.dropdowns.length)} | ${String(screen.actions.length)} | ${screen.mobileRelevant ? '📱' : '—'} | ${BADGE[statusOf(screen.id)]} |`,
    ),
    '',
    '## Pages',
    '',
    ...pages.map((screen) => screenSection(screen, report)),
    '## Dialogs, drawers and shared forms',
    '',
    ...dialogs.map((screen) => screenSection(screen, report)),
    '## Endpoints',
    '',
    '> Backend validation is authoritative (§6). A request that bypasses the UI must still be',
    '> refused, so every endpoint is listed whether or not a screen calls it.',
    '',
    '| Method | Path | Controller | Permissions its module requires | Status |',
    '| --- | --- | --- | --- | --- |',
    ...inventory.endpoints.map((endpoint) =>
      `| ${endpoint.method} | \`${endpoint.path}\` | ${endpoint.controller} | ${cell(list(endpoint.permissions, 4))} | ${BADGE[report.endpoints.get(endpoint.id) ?? 'NOT TESTED']} |`,
    ),
    '',
    '## Permission codes',
    '',
    '> A hidden menu is not security (§11). `TESTED` here means a test signed in without the',
    '> code and watched the API refuse — not that a button was hidden.',
    '',
    '| Code | Module | Status |',
    '| --- | --- | --- |',
    ...inventory.permissions.map((permission) =>
      `| \`${permission.code}\` | ${permission.module} | ${BADGE[report.permissions.get(permission.code) ?? 'NOT TESTED']} |`,
    ),
    '',
    '## Cross-module workflows',
    '',
    '| Workflow | Steps | Status |',
    '| --- | --- | --- |',
    ...inventory.workflows.map((workflow) =>
      `| ${workflow.name} | ${cell(workflow.steps.join(' → '))} | ${BADGE[report.workflows.get(workflow.id) ?? 'NOT TESTED']} |`,
    ),
    '',
  ].join('\n');
}

/**
 * The coverage report (§17), which exists to be read by somebody deciding
 * whether to ship — so it leads with what is not covered, not with a total.
 */
export function renderCoverage(inventory: Inventory, report: CoverageReport): string {
  const count = (status: Status): number =>
    report.screens.filter((entry) => entry.status === status).length;
  const applicable = report.screens.filter((entry) => entry.status !== 'NOT APPLICABLE');
  const endpointsTested = [...report.endpoints.values()].filter((status) => status === 'TESTED').length;
  const permissionsTested = [...report.permissions.values()].filter((status) => status === 'TESTED').length;
  const workflowsTested = [...report.workflows.values()].filter((status) => status === 'TESTED').length;
  const mobile = inventory.screens.filter((screen) => screen.mobileRelevant);
  const mobileTested = mobile.filter((screen) =>
    report.screens.some(
      (entry) => entry.screen.id === screen.id && entry.layers.includes('playwright-mobile'),
    ),
  );
  const fields = inventory.screens.flatMap((screen) =>
    screen.fields.map((field) => ({ screen, field })),
  );
  const dropdowns = inventory.screens.flatMap((screen) => screen.dropdowns.map(() => screen));
  const actions = inventory.screens.flatMap((screen) =>
    screen.actions.filter((action) => action.role === 'PRIMARY' || action.role === 'DESTRUCTIVE'),
  );

  const pct = (part: number, whole: number): string =>
    whole === 0 ? 'n/a' : `${String(Math.round((part / whole) * 100))}%`;

  const untested = report.screens.filter(
    (entry) => entry.status === 'NOT TESTED' || entry.status === 'PARTIALLY TESTED',
  );

  return [
    '# Automated Coverage Report',
    '',
    '> **Generated — do not edit by hand.** Run `pnpm test:inventory`.',
    '>',
    '> This counts *claims*, and a claim is a `@covers` line a test author wrote on purpose.',
    '> It does not count passing assertions, so it can only ever be an upper bound on what is',
    '> proved — which is why the untested list at the bottom, not the percentage at the top,',
    '> is the part worth reading.',
    '',
    '| | Total | Covered | |',
    '| --- | ---: | ---: | ---: |',
    `| Routes | ${String(inventory.screens.filter((screen) => screen.route !== null).length)} | ${String(applicable.filter((entry) => entry.screen.route !== null && entry.status === 'TESTED').length)} | ${pct(applicable.filter((entry) => entry.screen.route !== null && entry.status === 'TESTED').length, inventory.screens.filter((screen) => screen.route !== null).length)} |`,
    `| Forms, dialogs and drawers | ${String(inventory.screens.filter((screen) => screen.kind !== 'PAGE').length)} | ${String(applicable.filter((entry) => entry.screen.kind !== 'PAGE' && entry.status === 'TESTED').length)} | ${pct(applicable.filter((entry) => entry.screen.kind !== 'PAGE' && entry.status === 'TESTED').length, inventory.screens.filter((screen) => screen.kind !== 'PAGE').length)} |`,
    `| Fields | ${String(fields.length)} | ${String(fields.filter(({ screen, field }) => report.screens.some((entry) => entry.screen.id === screen.id && !entry.missing.includes(`required field ${field.id}`) && entry.status !== 'NOT TESTED')).length)} | — |`,
    `| Dropdowns | ${String(dropdowns.length)} | ${String(dropdowns.filter((screen) => report.screens.some((entry) => entry.screen.id === screen.id && entry.status === 'TESTED')).length)} | — |`,
    `| Business actions | ${String(actions.length)} | — | — |`,
    `| Endpoints | ${String(inventory.endpoints.length)} | ${String(endpointsTested)} | ${pct(endpointsTested, inventory.endpoints.length)} |`,
    `| Permission codes | ${String(inventory.permissions.length)} | ${String(permissionsTested)} | ${pct(permissionsTested, inventory.permissions.length)} |`,
    `| Critical workflows | ${String(inventory.workflows.length)} | ${String(workflowsTested)} | ${pct(workflowsTested, inventory.workflows.length)} |`,
    `| Mobile-relevant screens | ${String(mobile.length)} | ${String(mobileTested.length)} | ${pct(mobileTested.length, mobile.length)} |`,
    '',
    '## Screens by status',
    '',
    `- ✅ TESTED — ${String(count('TESTED'))}`,
    `- 🟡 PARTIALLY TESTED — ${String(count('PARTIALLY TESTED'))}`,
    `- ❌ NOT TESTED — ${String(count('NOT TESTED'))}`,
    `- ⬜ NOT APPLICABLE — ${String(count('NOT APPLICABLE'))}`,
    '',
    '## Everything not fully covered',
    '',
    untested.length === 0
      ? '_Nothing. Every applicable screen is fully claimed._'
      : ['| Screen | Status | What is missing |', '| --- | --- | --- |']
          .concat(
            untested.map(
              (entry) =>
                `| ${cell(entry.screen.name)} | ${BADGE[entry.status]} | ${cell(list(entry.missing, 10))} |`,
            ),
          )
          .join('\n'),
    '',
    '## Not applicable, with the reason',
    '',
    '| Screen | Why no automated test |',
    '| --- | --- |',
    ...report.screens
      .filter((entry) => entry.status === 'NOT APPLICABLE')
      .map((entry) => `| ${cell(entry.screen.name)} | ${cell(entry.reason ?? '')} |`),
    '',
    '## Claims that name nothing',
    '',
    report.unknownClaims.length === 0
      ? '_None._'
      : ['| Claim | File |', '| --- | --- |']
          .concat(
            report.unknownClaims.map((claim) => `| \`${claim.target}\` | \`${claim.file}\` |`),
          )
          .join('\n'),
    '',
  ].join('\n');
}

export { layerOf };
