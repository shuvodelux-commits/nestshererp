/**
 * The layering rules of SherERP, as data.
 *
 * Every rule here comes from AI_CODING_INSTRUCTIONS.md R-B / R-C8 and
 * SRS_AND_BUILD_GUIDE.md 2.1. Do not relax one to make a build pass:
 * a violation here is what silently makes the Phase 12 offline path impossible.
 */

/** Package scopes, as repo-relative directory prefixes. */
export const CORE_DOMAIN = 'packages/core-domain';
export const CORE_APPLICATION = 'packages/core-application';
export const ADAPTER_POSTGRES = 'packages/adapter-postgres';

/**
 * Phase 17 — the vendor's own processes.
 *
 * The control plane, the sidecar and the operator console are the *management*
 * plane. SRS §22 and §27 draw a hard line between them and the ERP's data
 * plane, and a line that is only a convention gets crossed the first time
 * somebody wants one type from the other side. These prefixes are what make the
 * ban checkable.
 */
export const CONTROL_PLANE = 'apps/control-plane';
export const AGENT = 'apps/agent';
export const ADMIN_CONSOLE = 'apps/admin';

/** The single file allowed to read the wall clock (implemented in slice 0.2). */
export const CLOCK_FILE = 'packages/shared-utils/src/clock.ts';

/**
 * Node built-ins banned in core-domain and core-application.
 * These two packages are bundled for the browser in Phase 12 (D-20 / D-23),
 * where none of these exist.
 */
const NODE_BUILTINS = ['fs', 'path', 'crypto', 'os', 'child_process'];

/** Browser globals that indicate DOM types leaked into a pure package. */
export const DOM_GLOBALS = ['document', 'window', 'navigator', 'localStorage'];

export interface ImportRule {
  /** Stable id, asserted by the tests. */
  readonly id: string;
  /** Repo-relative directory prefixes the rule applies to. */
  readonly scopes: readonly string[];
  /** True when the imported module specifier is forbidden in those scopes. */
  readonly isBanned: (specifier: string) => boolean;
  readonly message: string;
}

function isNodeBuiltin(specifier: string): boolean {
  const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
  return NODE_BUILTINS.includes(bare);
}

function isFramework(specifier: string): boolean {
  return specifier === '@nestjs' || specifier.startsWith('@nestjs/');
}

function isSqlDriver(specifier: string): boolean {
  return (
    specifier === 'drizzle-orm' ||
    specifier.startsWith('drizzle-orm/') ||
    specifier === 'pg' ||
    specifier.startsWith('pg/') ||
    specifier === 'better-sqlite3'
  );
}

/**
 * The ERP packages that carry a shop's business logic and its data.
 *
 * `core-contracts` is deliberately **not** on this list. It holds shapes and
 * canonical byte formats, and the licence format in particular has to be
 * identical on both sides — a second hand-written copy of
 * `canonicalLicensePayload` is exactly how the vendor ends up signing bytes
 * that customer installations do not verify. See
 * `apps/control-plane/src/licences/licence-payload.ts`.
 */
function isErpDataPlane(specifier: string): boolean {
  return (
    specifier.includes('core-domain') ||
    specifier.includes('core-application') ||
    specifier.includes('adapter-postgres') ||
    specifier.includes('adapter-sqlite-wasm')
  );
}

export const IMPORT_RULES: readonly ImportRule[] = [
  {
    id: 'domain-no-infrastructure',
    scopes: [CORE_DOMAIN],
    isBanned: (s) => isFramework(s) || isSqlDriver(s) || s === 'express',
    message: 'core-domain must not import @nestjs/*, drizzle-orm, pg, better-sqlite3 or express',
  },
  {
    id: 'application-no-infrastructure',
    scopes: [CORE_APPLICATION],
    isBanned: (s) => isFramework(s) || isSqlDriver(s),
    message: 'core-application must not import drizzle-orm, pg or @nestjs/*',
  },
  {
    id: 'no-node-builtins',
    scopes: [CORE_DOMAIN, CORE_APPLICATION],
    isBanned: isNodeBuiltin,
    message:
      'core-domain and core-application are bundled for the browser in Phase 12 and must not import Node built-ins',
  },
  {
    id: 'control-plane-no-erp-data-plane',
    scopes: [CONTROL_PLANE, AGENT, ADMIN_CONSOLE],
    isBanned: isErpDataPlane,
    message:
      'the vendor control plane, sidecar and console must not import the ERP\'s domain, application services or database adapters — they manage installations, they do not read a shop\'s books (§22, §27)',
  },
  {
    id: 'no-adapter-import',
    scopes: [CORE_DOMAIN, CORE_APPLICATION],
    isBanned: (s) => s.includes('adapter-postgres') || s.includes('adapter-sqlite-wasm'),
    message:
      'no adapter may be imported by core-domain or core-application — Phase 12.3 added the SQLite WASM one, and the rule holds for every adapter, not just the first',
  },
];

export const DOM_RULE = {
  id: 'domain-no-dom',
  scopes: [CORE_DOMAIN, CORE_APPLICATION],
  message: 'core-domain and core-application must not use DOM globals',
} as const;

export const CLOCK_RULE = {
  id: 'no-ambient-clock',
  message: `time must come from the Clock port; Date.now() and new Date() are allowed only in ${CLOCK_FILE}`,
} as const;
