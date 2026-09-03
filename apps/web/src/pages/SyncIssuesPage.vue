<script setup lang="ts">
import type { SyncConflictResponse } from '@sher/core-contracts';
import { computed, onMounted, ref } from 'vue';

import { fetchSyncConflicts, fetchSyncStatus, resolveSyncConflict } from '../api/sync';
import { useSession } from '../auth/session';
import AppShell from '../components/shell/AppShell.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import { taka } from '../components/money/money-text';
import { useSync } from '../offline/sync';

import { ApiError } from '../api/client';

/** The same shape every screen in this app turns a failure into (UI-28). */
function describe(cause: unknown, fallback: string): { code: string; message: string } {
  if (cause instanceof ApiError) return { code: cause.code, message: cause.message };
  return { code: 'INTERNAL_ERROR', message: fallback };
}

/**
 * Sync — what is waiting, and what the shop's books would not take
 * (§15, §16, Phase 12.4, owner decision 2026-09-02).
 *
 * **One queue, in one place.** A refused sale could have been shown on the
 * sales screen, a refused expense on the expenses screen, and each of them
 * would have been findable by somebody who already suspected it was there. The
 * whole risk this screen exists for is the opposite case: an outage ends,
 * everything looks normal, and three documents never went in. So the count sits
 * in the top bar until this list is empty, and the list is the authority.
 *
 * **A refusal is not an error.** The server checked the rules again and said no
 * — because the month was closed, because the permission was taken away, because
 * the product was archived — and each of those has a fix a person can make. The
 * page shows the reason in the server's own words, both sides of the
 * disagreement, and only the actions that can actually work for that reason.
 *
 * **Nothing here posts anything.** Retry and merge hand the operation back to
 * the service that refused it, against live state; discarding posts nothing and
 * erases nothing.
 */
const session = useSession();
const { pending, refused, syncNow, refresh } = useSync();

const conflicts = ref<readonly SyncConflictResponse[]>([]);
const status = ref<{ appliedCount: number; lastPushAt: string | null } | null>(null);
const filter = ref<'OPEN' | 'RESOLVED' | 'DISCARDED' | 'ALL'>('OPEN');
const loading = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const busyId = ref<string | null>(null);
const discarding = ref<SyncConflictResponse | null>(null);
const discardReason = ref('');

const canResolve = computed(() => session.can('sync.conflict.resolve'));
const canDiscard = computed(() => session.can('sync.conflict.discard'));

const WORDS: Readonly<Record<string, string>> = {
  SALE_CREATE: 'Sale',
  CUSTOMER_RECEIPT_RECORD: 'Customer payment',
  PURCHASE_CREATE: 'Purchase',
  SUPPLIER_PAYMENT_RECORD: 'Supplier payment',
  SALES_RETURN_CREATE: 'Customer return',
  PURCHASE_RETURN_CREATE: 'Supplier return',
  EXPENSE_RECORD: 'Expense',
  CASH_MOVEMENT_RECORD: 'Money movement',
  STOCK_ADJUST: 'Stock adjustment',
  CASH_DAY_OPEN: 'Day opened',
  CASH_DAY_CLOSE: 'Day closed',
  PARTY_CREATE: 'New customer or supplier',
  PRODUCT_CREATE: 'New product',
};

/** What each refusal means, in the words a shopkeeper would use about it. */
const REASONS: Readonly<Record<string, { en: string; bn: string }>> = {
  PERIOD_CLOSED: {
    en: 'The month this belongs to has been closed',
    bn: 'এই মাস বন্ধ করা হয়েছে',
  },
  PERMISSION_REVOKED: {
    en: 'The person who did this is no longer allowed to',
    bn: 'যিনি করেছেন তাঁর এখন অনুমতি নেই',
  },
  ENTITY_MISSING: { en: 'Something it names is no longer here', bn: 'এর সাথে যুক্ত কিছু আর নেই' },
  ENTITY_INACTIVE: { en: 'Something it names has been archived', bn: 'এর সাথে যুক্ত কিছু বন্ধ করা আছে' },
  UNIQUE_COLLISION: { en: 'The shop already has this', bn: 'দোকানে এটি আগে থেকেই আছে' },
  AMOUNT_DIVERGENCE: {
    en: 'The printed amount and the books disagree',
    bn: 'ছাপা টাকা আর হিসাবের টাকা মিলছে না',
  },
  VALIDATION_FAILED: { en: 'The books would not accept it as typed', bn: 'যেভাবে লেখা হয়েছে তা নেওয়া যায়নি' },
  DEPENDENCY_FAILED: {
    en: 'Something earlier in the queue has to go in first',
    bn: 'আগের একটি বিষয় আগে ঠিক করতে হবে',
  },
  AUTHORITY_REVOKED: {
    en: 'This computer’s offline permission was taken away',
    bn: 'এই কম্পিউটারের অফলাইন অনুমতি তুলে নেওয়া হয়েছে',
  },
  BUSINESS_RULE: { en: 'A shop rule refused it', bn: 'দোকানের একটি নিয়ম বাধা দিয়েছে' },
  UNKNOWN: { en: 'It could not go in, and no reason was given', bn: 'কারণ জানা যায়নি' },
};

const UNREADABLE = {
  en: 'It could not go in, and no reason was given',
  bn: 'কারণ জানা যায়নি',
};

function reasonOf(code: string): { en: string; bn: string } {
  return REASONS[code] ?? UNREADABLE;
}

const ACTION_WORDS: Readonly<Record<string, string>> = {
  RETRY: 'Try again',
  MERGE: 'Use what the shop already has',
  KEEP_BOTH_EDIT: 'Keep both',
  DISCARD_WITH_REASON: 'Never post this',
};

/**
 * One side of a conflict, in words (Phase 18.3).
 *
 * The state a device pushed is an operation payload, not a document, so it
 * carries plenty a manager cannot act on: the internal ids of the rows it
 * touches, the operation's own key, a version number. Those come out. What
 * stays is what somebody standing at the counter would recognise — an amount,
 * a quantity, a date, a name — with money turned back into taka, because a
 * `grandTotalMinor` of `49000` on a screen about a disputed sale is the kind of
 * figure that starts an argument.
 */
function readable(state: unknown): readonly { label: string; text: string }[] {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return [];

  return Object.entries(state as Record<string, unknown>).flatMap(([key, value]) => {
    if (value === null || value === undefined || typeof value === 'object') return [];
    // ULIDs and the keys that hold them: 26 characters nobody reads aloud.
    if (/(^|[a-z])Id$|^id$|^version$|^operationId$/.test(key)) return [];
    if (typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) return [];

    const label = key
      .replace(/Minor$/, '')
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (first) => first.toUpperCase())
      .trim();

    const text = key.endsWith('Minor') && typeof value === 'number'
      ? taka(value)
      : String(value);

    return [{ label, text }];
  });
}

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  failure.value = null;
  try {
    const [list, state] = await Promise.all([
      fetchSyncConflicts(token, filter.value),
      fetchSyncStatus(token),
    ]);
    conflicts.value = list.data;
    status.value = { appliedCount: state.appliedCount, lastPushAt: state.lastPushAt };
  } catch (cause) {
    failure.value = describe(cause, 'Could not read the sync queue');
  } finally {
    loading.value = false;
  }
}

async function act(conflict: SyncConflictResponse, resolution: string): Promise<void> {
  if (resolution === 'DISCARD_WITH_REASON') {
    discarding.value = conflict;
    discardReason.value = '';
    return;
  }
  const token = session.accessToken.value;
  if (token === null) return;
  busyId.value = conflict.id;
  failure.value = null;
  try {
    await resolveSyncConflict(token, conflict.id, { resolution });
    await load();
    await refresh();
  } catch (cause) {
    failure.value = describe(cause, 'That did not go in either');
  } finally {
    busyId.value = null;
  }
}

async function confirmDiscard(): Promise<void> {
  const conflict = discarding.value;
  const token = session.accessToken.value;
  if (conflict === null || token === null) return;
  busyId.value = conflict.id;
  try {
    await resolveSyncConflict(token, conflict.id, {
      resolution: 'DISCARD_WITH_REASON',
      reason: discardReason.value.trim(),
    });
    discarding.value = null;
    await load();
    await refresh();
  } catch (cause) {
    failure.value = describe(cause, 'Could not set this aside');
  } finally {
    busyId.value = null;
  }
}

async function sendNow(): Promise<void> {
  await syncNow();
  await load();
}

onMounted(load);
</script>

<template>
  <AppShell title="Sync" help-bn="সিংক — কী পাঠানো বাকি, আর কী দেখতে হবে">
    <div class="sync-page">
      <header class="head">
        <div></div>
        <button type="button" class="primary" :disabled="loading" @click="sendNow">
          Sync now
          <span class="bn-inline">এখন পাঠান</span>
        </button>
      </header>

      <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />

      <section class="tiles">
        <div class="tile">
          <span class="tile-value">{{ pending }}</span>
          <span class="tile-label">Waiting to send</span>
          <span class="bn">পাঠানো বাকি</span>
        </div>
        <div class="tile" :class="{ attention: refused > 0 }">
          <span class="tile-value">{{ refused }}</span>
          <span class="tile-label">Need review</span>
          <span class="bn">দেখতে হবে</span>
        </div>
        <div class="tile">
          <span class="tile-value">{{ status?.appliedCount ?? 0 }}</span>
          <span class="tile-label">Gone into the books</span>
          <span class="bn">হিসাবে ঢুকেছে</span>
        </div>
      </section>

      <nav class="filters" aria-label="Which sync issues to show">
        <button
          v-for="option in (['OPEN', 'RESOLVED', 'DISCARDED', 'ALL'] as const)"
          :key="option"
          type="button"
          class="filter"
          :class="{ on: filter === option }"
          @click="filter = option; void load()"
        >
          {{ option === 'OPEN' ? 'Needs review' : option === 'RESOLVED' ? 'Sorted out' : option === 'DISCARDED' ? 'Never posted' : 'All' }}
        </button>
      </nav>

      <p v-if="!loading && conflicts.length === 0" class="empty">
        Nothing is waiting for you here.
        <span class="bn">এখানে দেখার মতো কিছু নেই।</span>
      </p>

      <ul class="issues">
        <li v-for="conflict in conflicts" :key="conflict.id" class="issue">
          <div class="issue-head">
            <div>
              <strong>{{ WORDS[conflict.opType] ?? conflict.opType }}</strong>
              <span v-if="conflict.documentNumber !== null" class="doc">
                {{ conflict.documentNumber }}
              </span>
            </div>
            <span class="when">
              {{ conflict.businessDate }} · {{ conflict.deviceName }}
              <template v-if="conflict.deviceCode !== null"> ({{ conflict.deviceCode }})</template>
            </span>
          </div>

          <p class="reason">
            {{ reasonOf(conflict.reasonCode).en }}
            <span class="bn">{{ reasonOf(conflict.reasonCode).bn }}</span>
          </p>
          <!-- The server's own sentence, kept word for word: it was written for
               the person who caused the refusal, and a second, vaguer summary
               beside it would only compete with the one that is true. -->
          <p class="detail">{{ conflict.reasonMessage }}</p>

          <dl class="sides">
            <div>
              <dt>Typed at the counter</dt>
              <dd>{{ conflict.recordedByName }} · {{ new Date(conflict.deviceCreatedAt).toLocaleString() }}</dd>
            </div>
            <!--
              Phase 18.3 (owner decision 2026-09-03): these two were
              `JSON.stringify` of the raw operation — braces, quotes, ULIDs and
              minor units — on a screen a manager opens mid-shift to decide
              what to do about a refused sale. The values are the same; what is
              gone is the punctuation, the internal ids nobody can act on, and
              poisha printed as an integer.
            -->
            <div v-if="readable(conflict.localState).length > 0">
              <dt>What the slip said</dt>
              <dd>
                <span v-for="entry in readable(conflict.localState)" :key="entry.label" class="pair">
                  {{ entry.label }}: <strong>{{ entry.text }}</strong>
                </span>
              </dd>
            </div>
            <div v-if="readable(conflict.serverState).length > 0">
              <dt>What the books say</dt>
              <dd>
                <span v-for="entry in readable(conflict.serverState)" :key="entry.label" class="pair">
                  {{ entry.label }}: <strong>{{ entry.text }}</strong>
                </span>
              </dd>
            </div>
            <div v-if="conflict.attempts > 1">
              <dt>Tried</dt>
              <dd>{{ conflict.attempts }} times</dd>
            </div>
          </dl>

          <div v-if="conflict.status === 'OPEN'" class="actions">
            <template v-for="action in conflict.suggestedActions" :key="action">
              <!-- Only the actions that make sense for this refusal, and only
                   the ones this person holds the code for. An action nobody can
                   take is worse than no action at all (UI-09). -->
              <button
                v-if="action === 'DISCARD_WITH_REASON' ? canDiscard : canResolve"
                type="button"
                class="action"
                :class="{ danger: action === 'DISCARD_WITH_REASON' }"
                :disabled="busyId === conflict.id"
                @click="act(conflict, action)"
              >
                {{ ACTION_WORDS[action] ?? action }}
              </button>
            </template>
            <p v-if="!canResolve && !canDiscard" class="no-permission">
              A manager has to sort this one out.
              <span class="bn">একজন ম্যানেজারকে দেখতে হবে।</span>
            </p>
          </div>

          <p v-else class="settled">
            {{ conflict.status === 'DISCARDED' ? 'Set aside — never posted' : 'Sorted out' }}
            <template v-if="conflict.resolvedByName !== null">
              · {{ conflict.resolvedByName }}
            </template>
            <template v-if="conflict.resolutionReason !== null">
              · “{{ conflict.resolutionReason }}”
            </template>
          </p>
        </li>
      </ul>

      <div v-if="discarding !== null" class="scrim" @click.self="discarding = null">
        <div class="dialog" role="dialog" aria-modal="true">
          <h2>Never post this</h2>
          <p class="bn">এটি কখনও হিসাবে যাবে না</p>
          <p class="warn">
            Nothing is erased. The document, who made it and why you set it aside all stay
            readable forever — but the shop’s books will not contain it.
            <span class="bn">কিছুই মুছে যাবে না, কিন্তু হিসাবে ঢুকবে না।</span>
          </p>
          <label>
            Why?
            <span class="bn">কেন?</span>
            <textarea v-model="discardReason" rows="3" maxlength="500"></textarea>
          </label>
          <div class="dialog-actions">
            <button type="button" @click="discarding = null">Keep it waiting</button>
            <button
              type="button"
              class="danger"
              :disabled="discardReason.trim().length < 3 || busyId !== null"
              @click="confirmDiscard"
            >
              Never post it
            </button>
          </div>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.sync-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

h1 {
  margin: 0;
  font-size: 20px;
}

.bn {
  display: block;
  font-size: 12px;
  color: var(--sher-text-muted);
}

.bn-inline {
  margin-left: 6px;
  font-size: 11px;
  opacity: 0.85;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px;
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: var(--sher-radius, 8px);
  background: var(--sher-surface);
}

.tile.attention {
  border-color: var(--sher-warning, #b7791f);
}

.tile-value {
  font-size: 24px;
  font-weight: 700;
}

.tile-label {
  font-size: 13px;
}

.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.filter {
  min-height: 40px;
  padding: 6px 14px;
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: 999px;
  background: var(--sher-surface);
  cursor: pointer;
}

.filter.on {
  border-color: var(--sher-primary, #1b5e20);
  font-weight: 600;
}

.issues {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.issue {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: var(--sher-radius, 8px);
  background: var(--sher-surface);
}

.issue-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.doc {
  margin-left: 8px;
  font-variant-numeric: tabular-nums;
  color: var(--sher-text-muted);
}

.when {
  font-size: 12px;
  color: var(--sher-text-muted);
}

.reason {
  margin: 0;
  font-weight: 600;
}

.detail {
  margin: 0;
  font-size: 13px;
}

.sides {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 8px;
  margin: 0;
  font-size: 12px;
}

.sides dt {
  color: var(--sher-text-muted);
}

.sides dd {
  margin: 0;
  word-break: break-word;
}

/* One fact per line — a run-together sentence of pairs is the JSON again. */
.pair {
  display: block;
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.action,
.primary {
  min-height: 40px;
  padding: 8px 16px;
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: var(--sher-radius, 8px);
  background: var(--sher-surface);
  cursor: pointer;
}

.primary {
  background: var(--sher-primary, #1b5e20);
  color: #fff;
  border-color: transparent;
}

.action.danger,
button.danger {
  border-color: var(--sher-danger, #c0392b);
  color: var(--sher-danger, #c0392b);
}

.no-permission,
.settled,
.empty {
  margin: 0;
  font-size: 13px;
  color: var(--sher-text-muted);
}

.scrim {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 40%);
  display: grid;
  place-items: center;
  z-index: 50;
}

.dialog {
  width: min(520px, 92vw);
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px;
  border-radius: var(--sher-radius, 8px);
  background: var(--sher-surface);
}

.dialog h2 {
  margin: 0;
  font-size: 18px;
}

.warn {
  margin: 0;
  font-size: 13px;
}

.dialog textarea {
  width: 100%;
  margin-top: 4px;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.dialog-actions button {
  min-height: 40px;
  padding: 8px 16px;
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: var(--sher-radius, 8px);
  background: var(--sher-surface);
  cursor: pointer;
}
</style>
