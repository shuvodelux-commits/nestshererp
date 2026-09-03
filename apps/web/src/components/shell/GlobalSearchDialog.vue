<script setup lang="ts">
import type { GlobalSearchGroup, GlobalSearchHit, GlobalSearchKind } from '@sher/core-contracts';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';

import { globalSearch } from '../../api/search';
import { useSession } from '../../auth/session';
import { taka } from '../money/money-text';
import { resolveNavigation } from './navigation';

/**
 * Global Search (Phase 18.1, owner decision 2026-09-03).
 *
 * The box in the top bar carried a `Ctrl K` hint and did nothing for eleven
 * phases. This finishes it rather than inventing something new: one server
 * call over products, parties and documents, plus a `Go to…` list built from
 * the navigation architecture the shell already holds.
 *
 * **The two kinds of answer never interleave.** Records first, screen names in
 * their own group at the end. That separation is the condition the owner set
 * when he chose a command palette over a plain product search — a list that
 * mixes "the customer Rahim" with "the Reports screen" makes a shopkeeper read
 * every row to find out which kind each one is.
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ close: [] }>();

const router = useRouter();
const session = useSession();

const query = ref('');
const groups = ref<readonly GlobalSearchGroup[]>([]);
const searching = ref(false);
const failed = ref(false);
const selected = ref(0);
const input = ref<{ $el: HTMLElement } | null>(null);

/**
 * Which answer is current.
 *
 * Not an `AbortController`: `request()` reads a failed `fetch` as evidence the
 * line is down, and an abort is indistinguishable from one — cancelling a stale
 * keystroke would put the whole application into offline mode. A sequence
 * number costs one ignored response and never lies about the network.
 */
let sequence = 0;

const visible = computed({
  get: () => props.open,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

/** A shop's own screens, filtered by the same permissions that drew the sidebar. */
const destinations = computed(() =>
  resolveNavigation({ can: session.can, featureEnabled: session.featureEnabled })
    .flatMap((category) =>
      category.subcategories.map((subcategory) => ({
        id: subcategory.id,
        label: `${category.label} · ${subcategory.label}`,
        route: subcategory.route,
      })),
    ),
);

/**
 * Matching a screen name is deliberately dumber than matching a product: there
 * are forty of them, they are all in English, and a shopkeeper typing `day`
 * means Daybook or Daily Cash and is happy to be shown both.
 */
const goTo = computed(() => {
  const typed = query.value.trim().toLowerCase();
  if (typed === '') return [];
  return destinations.value.filter((item) => item.label.toLowerCase().includes(typed)).slice(0, 5);
});

/** Every row the arrow keys can land on, in the order they are drawn. */
interface Row {
  readonly key: string;
  readonly route: string;
}

const rows = computed<readonly Row[]>(() => [
  ...groups.value.flatMap((group) => group.hits.map((hit) => ({ key: `${hit.kind}:${hit.id}`, route: routeFor(hit) }))),
  ...goTo.value.map((item) => ({ key: `goto:${item.id}`, route: item.route })),
]);

const nothingFound = computed(() =>
  query.value.trim() !== '' && !searching.value && !failed.value && rows.value.length === 0,
);

/**
 * Where a hit opens.
 *
 * A party opens on its ledger rather than its edit form: "who is this person"
 * is answered by what they owe and what they bought, and the form is one click
 * from there. A product opens on its own page for the same reason.
 */
function routeFor(hit: GlobalSearchHit): string {
  switch (hit.kind) {
    case 'PRODUCT':
      return `/products/${hit.id}`;
    case 'SALE':
      return `/sales/${hit.id}`;
    case 'PURCHASE':
      return `/purchases/${hit.id}`;
    default:
      return `/parties/${hit.id}/ledger`;
  }
}

const ICONS: Record<GlobalSearchKind, string> = {
  PRODUCT: 'pi-box',
  CUSTOMER: 'pi-user',
  SUPPLIER: 'pi-truck',
  VENDOR: 'pi-briefcase',
  SALE: 'pi-receipt',
  PURCHASE: 'pi-shopping-cart',
};

async function run(typed: string): Promise<void> {
  const token = session.accessToken.value;
  const mine = ++sequence;
  if (token === null || typed.trim() === '') {
    groups.value = [];
    searching.value = false;
    failed.value = false;
    return;
  }

  searching.value = true;
  try {
    const response = await globalSearch(token, typed.trim());
    if (mine !== sequence) return;
    groups.value = response.data.groups;
    failed.value = false;
  } catch {
    if (mine !== sequence) return;
    // Nothing louder than this: a search that could not run is a disappointment,
    // not an incident, and the shopkeeper's next keystroke retries it anyway.
    groups.value = [];
    failed.value = true;
  } finally {
    if (mine === sequence) searching.value = false;
  }
}

/**
 * 180ms — long enough that typing a six-letter product name is one query rather
 * than six, short enough that the list appears to keep up with the keyboard.
 */
let debounce: ReturnType<typeof setTimeout> | undefined;

watch(query, (typed) => {
  selected.value = 0;
  if (debounce !== undefined) clearTimeout(debounce);
  debounce = setTimeout(() => void run(typed), 180);
});

// A palette that remembered the last search would show yesterday's answers for
// a moment every time it opens, which reads as the screen being stale.
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    query.value = '';
    groups.value = [];
    failed.value = false;
    selected.value = 0;
    void nextTick(() => input.value?.$el?.focus());
  },
);

function move(step: number): void {
  const count = rows.value.length;
  if (count === 0) return;
  selected.value = (selected.value + step + count) % count;
}

async function open(route: string): Promise<void> {
  emit('close');
  await router.push(route);
}

async function choose(): Promise<void> {
  const row = rows.value[selected.value];
  if (row !== undefined) await open(row.route);
}

function indexOfKey(key: string): number {
  return rows.value.findIndex((row) => row.key === key);
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    dismissable-mask
    :draggable="false"
    class="palette"
    :show-header="false"
    :style="{ width: '38rem' }"
    aria-label="Search products, parties and documents"
    @keydown.down.prevent="move(1)"
    @keydown.up.prevent="move(-1)"
    @keydown.enter.prevent="choose()"
    @keydown.esc="emit('close')"
  >
    <div class="palette-search">
      <i class="pi pi-search" aria-hidden="true" />
      <InputText
        ref="input"
        v-model="query"
        type="search"
        placeholder="Search products, parties, documents"
        aria-label="Search products, parties and documents"
        autocomplete="off"
      />
      <span v-if="searching" class="palette-busy">Searching…</span>
    </div>

    <div class="palette-results">
      <p v-if="query.trim() === ''" class="palette-hint">
        Type a product name, a customer's phone, or an invoice number.
        <span class="palette-hint-bn">পণ্য, কাস্টমার বা ইনভয়েস নম্বর লিখুন</span>
      </p>

      <p v-else-if="failed" class="palette-hint">
        Search could not run just now. Keep typing to try again.
      </p>

      <p v-else-if="nothingFound" class="palette-hint">
        Nothing matches “{{ query.trim() }}”.
        <span class="palette-hint-bn">কিছু পাওয়া যায়নি</span>
      </p>

      <template v-else>
        <section v-for="group in groups" :key="group.kind" class="palette-group">
          <h3>{{ group.label }}</h3>
          <button
            v-for="hit in group.hits"
            :key="hit.id"
            type="button"
            class="palette-row"
            :class="{ 'is-current': indexOfKey(`${hit.kind}:${hit.id}`) === selected }"
            @mouseenter="selected = indexOfKey(`${hit.kind}:${hit.id}`)"
            @click="open(routeFor(hit))"
          >
            <i class="pi" :class="ICONS[hit.kind]" aria-hidden="true" />
            <span class="palette-text">
              <strong>{{ hit.title }}</strong>
              <span v-if="hit.subtitle !== null">{{ hit.subtitle }}</span>
            </span>
            <span v-if="hit.date !== null" class="palette-meta">{{ hit.date }}</span>
            <span v-if="hit.amountMinor !== null" class="palette-amount">{{ taka(hit.amountMinor) }}</span>
          </button>
        </section>

        <!--
          Separately grouped and always last: a screen name is a different kind
          of answer from a record, and the owner's condition for accepting the
          palette was that the two never mix.
        -->
        <section v-if="goTo.length > 0" class="palette-group palette-goto">
          <h3>Go to…</h3>
          <button
            v-for="item in goTo"
            :key="item.id"
            type="button"
            class="palette-row"
            :class="{ 'is-current': indexOfKey(`goto:${item.id}`) === selected }"
            @mouseenter="selected = indexOfKey(`goto:${item.id}`)"
            @click="open(item.route)"
          >
            <i class="pi pi-arrow-right" aria-hidden="true" />
            <span class="palette-text"><strong>{{ item.label }}</strong></span>
          </button>
        </section>
      </template>
    </div>

    <p class="palette-foot">
      <kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close
    </p>
  </Dialog>
</template>

<style scoped>
.palette-search {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 4px 12px;
  border-bottom: 1px solid var(--sher-line);
}

.palette-search > .pi {
  color: var(--sher-text-faint);
}

.palette-search :deep(.p-inputtext) {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  font-size: var(--sher-text-md);
}

.palette-busy {
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
}

.palette-results {
  max-height: 22rem;
  overflow-y: auto;
  padding: 8px 0;
}

.palette-hint {
  padding: 20px 8px;
  text-align: center;
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
}

.palette-hint-bn {
  display: block;
  font-size: var(--sher-text-2xs);
}

.palette-group h3 {
  padding: 8px 8px 4px;
  font-size: var(--sher-text-2xs);
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--sher-text-muted);
}

.palette-goto {
  margin-top: 6px;
  border-top: 1px solid var(--sher-line);
}

.palette-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--sher-radius);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.palette-row.is-current {
  background: var(--sher-sunken);
}

.palette-row > .pi {
  color: var(--sher-text-muted);
}

.palette-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  line-height: 1.3;
}

.palette-text strong {
  font-size: var(--sher-text-sm);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.palette-text span {
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.palette-meta,
.palette-amount {
  flex-shrink: 0;
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
  font-variant-numeric: tabular-nums;
}

.palette-amount {
  font-size: var(--sher-text-sm);
  font-weight: 600;
  color: var(--sher-text);
}

.palette-foot {
  padding-top: 10px;
  border-top: 1px solid var(--sher-line);
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
}

.palette-foot kbd {
  font-family: var(--sher-font);
  font-weight: 600;
  border: 1px solid var(--sher-line-strong);
  border-radius: var(--sher-radius-sm);
  padding: 1px 5px;
  margin-right: 3px;
  background: var(--sher-raised);
}
</style>
