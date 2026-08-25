import { ref, watch } from 'vue';
import type { Ref } from 'vue';

/**
 * One signal that says "something was posted" (owner rule, binding).
 *
 * The owner's rule is that a figure never waits for a reload. Inside one screen
 * that is reactivity; **across** screens it is not, and this is the gap the
 * owner found: a sale took ৳2,000 out of the drawer, the day chip in the top
 * bar showed the new figure because it had just refetched, and Money Accounts —
 * loaded a minute earlier — went on showing the old balance until the page was
 * reloaded. Two correct numbers, one of them stale, which reads as a broken
 * ledger.
 *
 * Every derived figure in SherERP is computed from the journal on read (INV-06,
 * INV-07): a balance, a due, a stock position. So any successful write can
 * invalidate any of them, and the honest rule is the blunt one — **when
 * anything is posted, every open screen refetches what it is showing.** The
 * `request` client bumps this after each non-GET, so no caller has to remember,
 * and no screen has to know which other screen changed what.
 *
 * It is deliberately a counter and not an event bus with topics. Topics would
 * mean deciding, at every call site, which screens a sale affects — and the
 * first one forgotten is another stale balance. A refetch costs one indexed
 * query; a wrong number on screen costs the shopkeeper's trust in the books.
 */
const version = ref(0);

export function markDataChanged(): void {
  version.value += 1;
}

/** The counter itself, for a component that would rather watch it directly. */
export const dataVersion: Readonly<Ref<number>> = version;

/**
 * Re-run `reload` whenever anything is posted.
 *
 * Call it in `setup`; the watcher dies with the component. It does **not** run
 * `reload` immediately — a screen loads itself in `onMounted`, and running it
 * twice on open would double every first paint.
 */
export function onDataChanged(reload: () => void | Promise<void>): void {
  watch(version, () => {
    void reload();
  });
}
