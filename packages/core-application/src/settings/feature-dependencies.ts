import type { SettingDescriptor } from '@sher/core-contracts';
import { SETTING_CATALOGUE, TOGGLE_OFF, TOGGLE_ON } from '@sher/core-contracts';

/**
 * Feature dependency rules for tenant settings (§5.21).
 *
 * §5.21 is binding on the outcome, not the mechanism: "invalid combinations are
 * prevented, not merely discouraged", and "turning off a parent feature must
 * either cascade or be refused with an explanation — **never** leave a
 * dependent feature enabled and broken."
 *
 * SherERP takes both permitted routes, one in each direction, because the two
 * directions are not symmetrical:
 *
 *   Turning a parent **off** cascades. The owner asked for the parent to stop;
 *   refusing until they have hunted down every child first is work the software
 *   can do, and the result is named back to them so nothing turns off silently.
 *
 *   Turning a child **on** is refused, naming the parent. Enabling the parents
 *   on their behalf would switch on features they never asked for — consignment
 *   would quietly create a vendor ledger — and a feature nobody chose is one
 *   nobody is watching.
 *
 * Pure: no clock, no I/O, no persistence. Same input, same output. It sits in
 * `core-application` rather than `core-domain` only because the catalogue it
 * reasons over lives in `core-contracts`, which `core-domain` may not import
 * (R-B2). R-B1 allows business logic in either package; what it forbids is a
 * controller, a Vue file or SQL, and this is none of those.
 */

const BY_KEY = new Map<string, SettingDescriptor>(
  SETTING_CATALOGUE.map((descriptor) => [descriptor.key, descriptor]),
);

/** Reverse of `requires`: which settings name this one as a parent. */
const DEPENDENTS = new Map<string, string[]>();
for (const descriptor of SETTING_CATALOGUE) {
  for (const parent of descriptor.requires) {
    DEPENDENTS.set(parent, [...(DEPENDENTS.get(parent) ?? []), descriptor.key]);
  }
}

export function settingDescriptor(key: string): SettingDescriptor | null {
  return BY_KEY.get(key) ?? null;
}

/** Whether `value` is one this setting is allowed to hold. */
export function isAllowedValue(descriptor: SettingDescriptor, value: string): boolean {
  return descriptor.options.includes(value);
}

/**
 * The parents that would have to be on first, given the values as they stand.
 * Empty when the change is allowed.
 *
 * Only turning something **on** can be blocked — turning off never needs a
 * parent, and a `CHOICE` setting with an unmet parent (expired-stock policy
 * without expiry tracking) is a stored preference for a feature that is not
 * running, not an invalid combination.
 */
export function unmetParents(
  descriptor: SettingDescriptor,
  value: string,
  values: ReadonlyMap<string, string>,
): readonly SettingDescriptor[] {
  if (descriptor.kind !== 'TOGGLE' || value !== TOGGLE_ON) return [];

  return descriptor.requires
    .map((key) => BY_KEY.get(key))
    .filter((parent): parent is SettingDescriptor => parent !== undefined)
    .filter((parent) => effectiveValue(parent, values) !== TOGGLE_ON);
}

/**
 * Everything that must turn off with this one, transitively.
 *
 * Transitive matters: vendor management carries the vendor ledger, and the
 * vendor ledger carries consignment. Cascading one level would leave
 * consignment on with no ledger to post to — exactly the broken dependent
 * §5.21 forbids.
 *
 * Returns descriptors in a stable order, parents before their children, so the
 * message the owner reads follows the same shape as the dependency.
 */
export function cascadeOff(
  descriptor: SettingDescriptor,
  value: string,
  values: ReadonlyMap<string, string>,
): readonly SettingDescriptor[] {
  if (descriptor.kind !== 'TOGGLE' || value !== TOGGLE_OFF) return [];

  const falling: SettingDescriptor[] = [];
  const seen = new Set<string>([descriptor.key]);
  const queue: string[] = [descriptor.key];

  while (queue.length > 0) {
    const parentKey = queue.shift();
    if (parentKey === undefined) continue;

    for (const childKey of DEPENDENTS.get(parentKey) ?? []) {
      if (seen.has(childKey)) continue;
      const child = BY_KEY.get(childKey);
      if (child === undefined || child.kind !== 'TOGGLE') continue;
      // Already off. Nothing to cascade, and nothing below it can be on either:
      // the same rule kept its own children off when it went.
      if (effectiveValue(child, values) !== TOGGLE_ON) continue;

      seen.add(childKey);
      falling.push(child);
      queue.push(childKey);
    }
  }

  return falling;
}

/**
 * The value in force: what the tenant stored, or the shipped default when they
 * have never touched it.
 *
 * A missing row means "never changed", not "off". Reading it as off would make
 * a default-on setting silently absent until somebody saved it once.
 */
export function effectiveValue(
  descriptor: SettingDescriptor,
  values: ReadonlyMap<string, string>,
): string {
  return values.get(descriptor.key) ?? descriptor.defaultValue;
}

/**
 * Whether a feature toggle is on, defaults included.
 *
 * The one place any module asks "is this switched on for this shop", so the
 * answer for an absent row is the shipped default everywhere and not just where
 * someone remembered (§5.21).
 */
export function isFeatureOn(values: ReadonlyMap<string, string>, key: string): boolean {
  const descriptor = BY_KEY.get(key);
  return descriptor !== undefined && effectiveValue(descriptor, values) === TOGGLE_ON;
}

/** The stored rows as a lookup, for `isFeatureOn` and `effectiveValue`. */
export function settingValuesOf(
  stored: readonly { readonly key: string; readonly value: string }[],
): Map<string, string> {
  return new Map(stored.map((row) => [row.key, row.value]));
}

/** Every setting's value in force, defaults filled in. */
export function effectiveSettings(values: ReadonlyMap<string, string>): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const descriptor of SETTING_CATALOGUE) {
    resolved.set(descriptor.key, effectiveValue(descriptor, values));
  }
  return resolved;
}
