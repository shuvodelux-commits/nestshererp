import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { buildCoverage, readClaims } from './coverage.js';
import { buildInventory } from './scan.js';
import { renderCoverage, renderMatrix } from './render.js';

/**
 * Regenerates the test matrix and the coverage report from the source.
 *
 * `--check` is the CI form: it regenerates and fails if a claim names something
 * that no longer exists, which is the one condition that makes the report lie.
 */
function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const inventory = buildInventory(root);
  const claims = readClaims(root, {
    permissionCodes: inventory.permissions.map((entry) => entry.code),
    routedScreenIds: inventory.screens
      .filter((screen) => screen.route !== null && screen.kind === 'PAGE')
      .map((screen) => screen.id),
    mobileScreenIds: inventory.screens
      .filter((screen) => screen.mobileRelevant)
      .map((screen) => screen.id),
  });
  const report = buildCoverage(inventory, claims);

  const out = join(root, 'docs/testing');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  writeFileSync(join(out, 'ERP-TEST-MATRIX.md'), renderMatrix(inventory, report), 'utf8');
  writeFileSync(join(out, 'COVERAGE.md'), renderCoverage(inventory, report), 'utf8');

  const screens = inventory.screens.length;
  process.stdout.write(
    `test-inventory: ${String(screens)} screens, ${String(inventory.endpoints.length)} endpoints, ` +
      `${String(inventory.permissions.length)} permissions, ${String(claims.length)} coverage claims\n`,
  );

  if (report.unknownClaims.length > 0) {
    for (const claim of report.unknownClaims) {
      process.stderr.write(`  claims something that does not exist: ${claim.target} (${claim.file})\n`);
    }
    if (process.argv.includes('--check')) process.exitCode = 1;
  }
}

main();
