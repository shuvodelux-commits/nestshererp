<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { fetchProviderStatus } from '../../api/provider';
import type { ProviderStatus } from '../../api/provider';
import { useSession } from '../../auth/session';

/**
 * "Software Provider Support active" (Phase 17, §15, owner decision 2026-09-03).
 *
 * A small, non-blocking line — nothing to click, nothing to approve. Remote
 * access is pre-authorized by the support arrangement agreed at deployment, so
 * the shop is not asked each time; the owner also decided against a Support
 * History screen, so this is the whole of what the shop sees.
 *
 * But it is never hidden. §15's rule survives the owner's simplification: a
 * vendor session happening invisibly is the one thing that is not acceptable,
 * and the authoritative permanent record lives in the vendor's control plane
 * where it cannot be edited.
 *
 * It polls rather than pushes. A session is minutes long and a minute of
 * latency at the start of one is not worth a socket held open on every till in
 * every shop for the ninety-nine per cent of the time nobody is in.
 */
const session = useSession();
const status = ref<ProviderStatus | null>(null);
let timer: ReturnType<typeof setInterval> | undefined;

const active = computed(() => status.value?.supportSession ?? null);

async function poll(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    status.value = await fetchProviderStatus(token);
  } catch {
    // An installation with no management agent answers 404 here, and that is
    // the normal case for a shop sold without remote support. It must never
    // break the screen behind it.
    status.value = null;
  }
}

onMounted(() => {
  void poll();
  timer = setInterval(() => void poll(), 60_000);
});
onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer);
});
</script>

<template>
  <div v-if="active" class="prov-note" role="status">
    <span class="prov-note__dot" aria-hidden="true" />
    <span class="prov-note__text">
      Software Provider Support active — {{ active.operatorName }}. Reason: {{ active.reason }}.
    </span>
    <span class="prov-note__bn">সফটওয়্যার প্রোভাইডার এখন সাপোর্টে যুক্ত আছেন।</span>
  </div>
</template>

<style scoped>
.prov-note {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.25rem 0.65rem;
  padding: 0.4rem 1rem;
  font-size: 0.82rem;
  line-height: 1.4;
  color: var(--sher-text-muted, #475569);
  background: color-mix(in srgb, var(--sher-accent, #2563eb) 8%, transparent);
  border-bottom: 1px solid var(--sher-line);
}
.prov-note__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: var(--sher-accent, #2563eb);
  flex: none;
}
.prov-note__bn {
  font-size: 0.78rem;
  opacity: 0.8;
}
</style>
