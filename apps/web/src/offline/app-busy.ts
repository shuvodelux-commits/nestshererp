import { computed, onBeforeUnmount, ref, watchEffect } from 'vue';
import type { ComputedRef } from 'vue';

/**
 * "Do not interrupt this screen right now."
 *
 * The owner's rule for updates is *prompt to reload, never mid-sale*
 * (2026-08-31). A half-typed bill is real work that exists nowhere but this
 * tab, and throwing it away to install a new build is the kind of small,
 * repeated betrayal that makes a shop stop trusting the app.
 *
 * A counter rather than a flag, because two screens can be busy at once — a POS
 * cart in one tab and a purchase form in another — and the update must wait for
 * the last of them.
 */
const holds = ref(0);

export const appIsBusy: ComputedRef<boolean> = computed(() => holds.value > 0);

/**
 * Hold the app while `busy()` is true, releasing when it stops being true and
 * again when the component unmounts — so a cashier who navigates away from a
 * half-typed bill does not leave the update blocked forever.
 */
export function holdWhileBusy(busy: () => boolean): void {
  let held = false;
  const stop = watchEffect(() => {
    const want = busy();
    if (want === held) return;
    holds.value += want ? 1 : -1;
    held = want;
  });

  onBeforeUnmount(() => {
    stop();
    if (held) {
      holds.value -= 1;
      held = false;
    }
  });
}
