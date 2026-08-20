<script setup lang="ts">
import type { StatTone } from '../design/tones';

/**
 * A summary tile: one figure, what it counts, and an icon in its tone.
 *
 * UI-23 puts summary figures in cards and transactional data in tables. This is
 * the card. Two shapes, one component:
 *
 * - `filled` — the gradient tile a dashboard uses for the day's headline
 *   numbers. Loud on purpose, and rationed: never more than six across a row.
 * - default — a white tile with a coloured icon disc, which is what a module's
 *   list screen uses above its table so the figures do not compete with the
 *   rows underneath.
 *
 * The tone is chosen by **meaning**, not by taste (see `tokens.css`): money in
 * is blue, cost is slate, profit is green, something needing attention is
 * amber, a receivable is violet, a payable is rose. Two modules using the same
 * tone for different meanings is the thing this prop exists to prevent.
 *
 * `value` is already formatted. UI-31 puts money and quantity formatting in
 * `shared-utils`, never in a component, so this one only ever renders a string.
 */
defineProps<{
  label: string;
  value: string;
  /** The line under the figure: "78.7% of total", "12 customers". */
  detail?: string;
  icon: string;
  tone: StatTone;
  filled?: boolean;
}>();
</script>

<template>
  <article class="stat" :class="[`tone-${tone}`, filled === true ? 'is-filled' : 'is-plain']">
    <div class="stat-text">
      <p class="stat-label">{{ label }}</p>
      <p class="stat-value">{{ value }}</p>
      <p v-if="detail !== undefined" class="stat-detail">{{ detail }}</p>
    </div>
    <span class="disc" aria-hidden="true">
      <i class="pi" :class="icon" />
    </span>
  </article>
</template>

<style scoped>
.stat {
  display: flex;
  align-items: flex-start;
  gap: var(--sher-space-2);
  padding: var(--sher-card-pad);
  border-radius: var(--sher-radius-lg);
  border: 1px solid var(--sher-line);
  background: var(--sher-raised);
  box-shadow: var(--sher-shadow-card);
  min-width: 0;
}

.stat-text {
  min-width: 0;
}

.stat-label {
  margin: 0;
  font-size: var(--sher-text-sm);
  font-weight: 600;
}

.stat-value {
  margin: 4px 0 0;
  font-size: var(--sher-text-xl);
  font-weight: 700;
  line-height: 1.15;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.stat-detail {
  margin: 4px 0 0;
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
}

.disc {
  margin-left: auto;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  font-size: 17px;
}

/* --- plain: white card, the tone lives in the disc and the figure --------- */
.is-plain .stat-label {
  color: var(--sher-tone);
}

.is-plain .stat-value {
  color: var(--sher-text);
}

.is-plain .disc {
  background: var(--sher-tone-fill);
  color: var(--sher-on-tone);
  box-shadow: var(--sher-shadow-tone);
}

/* --- filled: the whole tile carries the tone ------------------------------ */
.is-filled {
  background: var(--sher-tone-fill);
  border-color: transparent;
  box-shadow: var(--sher-shadow-tone);
}

.is-filled .stat-label,
.is-filled .stat-value {
  color: var(--sher-on-tone);
}

.is-filled .stat-label {
  opacity: 0.92;
}

.is-filled .stat-detail {
  color: var(--sher-on-tone);
  opacity: 0.85;
}

.is-filled .disc {
  background: rgba(255, 255, 255, 0.18);
  color: var(--sher-on-tone);
}

/* In dark mode the filled tile is a tinted panel rather than poster paint, so
   it keeps a visible edge and the figure takes the colour instead. */
:root[data-theme='dark'] .is-filled {
  border-color: var(--sher-line);
}

:root[data-theme='dark'] .is-filled .stat-value {
  color: var(--sher-tone);
}

/* Each tone resolves the two variables the rules above read. */
.tone-blue {
  --sher-tone: var(--sher-tone-blue);
  --sher-tone-fill: var(--sher-tone-blue-fill);
}

.tone-slate {
  --sher-tone: var(--sher-tone-slate);
  --sher-tone-fill: var(--sher-tone-slate-fill);
}

.tone-green {
  --sher-tone: var(--sher-tone-green);
  --sher-tone-fill: var(--sher-tone-green-fill);
}

.tone-amber {
  --sher-tone: var(--sher-tone-amber);
  --sher-tone-fill: var(--sher-tone-amber-fill);
}

.tone-violet {
  --sher-tone: var(--sher-tone-violet);
  --sher-tone-fill: var(--sher-tone-violet-fill);
}

.tone-rose {
  --sher-tone: var(--sher-tone-rose);
  --sher-tone-fill: var(--sher-tone-rose-fill);
}
</style>
