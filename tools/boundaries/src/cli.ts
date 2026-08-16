import { resolve } from 'node:path';

import { checkBoundaries, formatViolations } from './check';

const repoRoot = resolve(__dirname, '../../..');
const violations = checkBoundaries(repoRoot);

if (violations.length > 0) {
  process.stderr.write(`Boundary violations (${violations.length}):\n`);
  process.stderr.write(`${formatViolations(violations)}\n`);
  process.exit(1);
}

process.stdout.write('Boundaries OK — no layering violations.\n');
