import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkBoundaries, formatViolations } from '../src/check';

const REPO_ROOT = resolve(__dirname, '../../..');
const FIXTURE_ROOT = resolve(__dirname, '../__fixtures__');

/** rule id + file, which is what a developer needs to act on. */
function keys(root: string): string[] {
  return checkBoundaries(root)
    .map((v) => `${v.rule} ${v.file}`)
    .sort();
}

describe('boundary checker', () => {
  it('catches every deliberate violation in the fixtures', () => {
    expect(keys(FIXTURE_ROOT)).toEqual([
      'application-no-infrastructure packages/core-application/src/bad-infrastructure.ts',
      'application-no-infrastructure packages/core-application/src/bad-infrastructure.ts',
      'application-no-infrastructure packages/core-application/src/bad-infrastructure.ts',
      'domain-no-dom packages/core-domain/src/bad-dom.ts',
      'domain-no-infrastructure packages/core-domain/src/bad-database.ts',
      'domain-no-infrastructure packages/core-domain/src/bad-database.ts',
      'domain-no-infrastructure packages/core-domain/src/bad-database.ts',
      'domain-no-infrastructure packages/core-domain/src/bad-framework.ts',
      'domain-no-infrastructure packages/core-domain/src/bad-framework.ts',
      'no-adapter-import packages/core-application/src/bad-adapter.ts',
      'no-adapter-import packages/core-application/src/bad-adapter.ts',
      'no-ambient-clock apps/api/src/bad-clock.ts',
      'no-ambient-clock packages/core-domain/src/bad-clock.ts',
      'no-ambient-clock packages/core-domain/src/bad-clock.ts',
      'no-node-builtins packages/core-application/src/bad-infrastructure.ts',
      'no-node-builtins packages/core-domain/src/bad-node-builtin.ts',
      'no-node-builtins packages/core-domain/src/bad-node-builtin.ts',
    ]);
  });

  it('exempts the Clock implementation from the ambient-clock rule', () => {
    const clockFile = 'packages/shared-utils/src/clock.ts';
    expect(checkBoundaries(FIXTURE_ROOT).filter((v) => v.file === clockFile)).toEqual([]);
  });

  it('passes on the real source', () => {
    const violations = checkBoundaries(REPO_ROOT);
    expect(formatViolations(violations)).toBe('');
    expect(violations).toEqual([]);
  });
});
