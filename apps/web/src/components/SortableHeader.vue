<script setup lang="ts">
import type { SortDirection } from '@sher/core-contracts';
import Button from 'primevue/button';
import { computed } from 'vue';

/**
 * A table header that sorts when it is tapped (UI-46).
 *
 * One component for every list in SherERP, so the interaction is identical
 * everywhere: tap to sort, tap again to reverse, an arrow on the active column
 * showing which way. That sameness is the point — a shopkeeper learns it once on
 * the Products screen and it is already true on Customers, Suppliers and every
 * list Phase 3 onwards adds.
 *
 * The model is the one they already use on an Android phone's gallery and file
 * manager, which is why there is no "Sort by…" dropdown anywhere in the app: a
 * menu hides the fact that the list *can* be reordered, and this audience does
 * not go looking inside menus for capabilities they have not been shown.
 *
 * **The whole header is the button**, not a small icon inside it. A tap target
 * the width of the column is one a thumb hits on the first try; a 16px chevron
 * is one that gets missed and turns into a mis-tap on the row beneath.
 */
const props = defineProps<{
  /** The sort key this header owns, from the endpoint's closed allow-list. */
  column: string;
  /** Which column the list is currently ordered by. */
  active: string;
  direction: SortDirection;
  /** English label (UI-14) and its Bangla helper (UI-16). */
  label: string;
  labelBn?: string | undefined;
  /** Right-aligned for money and quantity, matching UI-32. */
  numeric?: boolean | undefined;
}>();

const emit = defineEmits<{ (event: 'sort', column: string): void }>();

const isActive = computed(() => props.active === props.column);

/**
 * Announced to a screen reader as the column's sort state, which is what
 * `aria-sort` exists for — the arrow alone is invisible to one.
 */
const ariaSort = computed(() => {
  if (!isActive.value) return 'none';
  return props.direction === 'ASC' ? 'ascending' : 'descending';
});

/**
 * The arrow points the way the reader will find the result: down for
 * biggest/latest first, up for smallest/A-first. Naming it in words as well as
 * drawing it keeps UI-32's rule — never colour or shape alone.
 */
const arrow = computed(() => (props.direction === 'ASC' ? 'pi-arrow-up' : 'pi-arrow-down'));
</script>

<template>
  <th :aria-sort="ariaSort" :class="{ num: numeric, 'is-sorted': isActive }">
    <Button text class="sort-button" @click="emit('sort', column)">
      <span class="sort-label">
        {{ label }}
        <span v-if="labelBn" class="sher-bn header-bn">{{ labelBn }}</span>
      </span>
      <i
        class="pi sort-arrow"
        :class="[arrow, { 'is-hidden': !isActive }]"
        aria-hidden="true"
      />
    </Button>
  </th>
</template>

<style scoped>
/*
 * The button fills the header cell so the tap target is the whole column width,
 * not the text. `inherit` on font and colour keeps it looking like a table
 * header rather than a button — it should read as a label that happens to
 * respond, which is exactly how the phone apps this borrows from behave.
 */
.sort-button {
  display: flex;
  align-items: baseline;
  justify-content: flex-start;
  gap: 0.375rem;
  width: 100%;
  min-height: 2.25rem;
  padding: 0.25rem 0;
  font: inherit;
  color: inherit;
  /*
   * Explicit, because `font: inherit` does not carry either of these and the
   * user-agent's `button { text-transform: none }` reset actively cancels the
   * first. Left to inherit, a sortable column rendered "Product" next to a
   * plain column's "STOCK" in the same header row.
   */
  text-transform: inherit;
  letter-spacing: inherit;
  text-align: left;
  cursor: pointer;
}

th.num .sort-button {
  justify-content: flex-end;
  text-align: right;
}

/*
 * English label and Bangla helper on **one line** (UI-16), the same way a form
 * field carries its `.label-bn`.
 *
 * Stacked, the Bangla became a second header row: every list grew about 18px of
 * chrome above the first record, and the eye had to skip a line of text it may
 * not read to reach the data. Beside the label it is what it is — the same
 * column name, said the other way — and the table starts a row sooner.
 */
.sort-label {
  display: flex;
  align-items: baseline;
  gap: 0.375rem;
  min-width: 0;
}

.header-bn {
  font-weight: 400;
  font-size: var(--sher-text-2xs);
  letter-spacing: normal;
  text-transform: none;
  opacity: 0.75;
}

.sort-arrow {
  font-size: 0.75rem;
  flex-shrink: 0;
}

/*
 * The inactive arrow keeps its space rather than being removed, so tapping
 * between columns does not shuffle every header sideways by a few pixels —
 * movement that reads as the table having changed when it has not.
 */
.sort-arrow.is-hidden {
  visibility: hidden;
}

.sort-button:focus-visible {
  outline: 2px solid var(--sher-focus, #2563eb);
  outline-offset: 2px;
}
</style>
