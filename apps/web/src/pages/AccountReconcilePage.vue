<script setup lang="ts">
import type {
  MatchSuggestion,
  ReconciliationLedgerRow,
  ReconciliationStatementRow,
  ReconciliationWorkspaceResponse,
} from '@sher/core-contracts';
import Button from 'primevue/button';
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError, loadConfig } from '../api/client';
import { fetchAccounts } from '../api/money';
import {
  fetchReconciliation,
  openStatementFile,
  removeMatch,
  reopenReconciliation,
  saveMatch,
} from '../api/reconciliation';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AddMissingEntryDialog from '../components/money/AddMissingEntryDialog.vue';
import CompleteReconciliationDialog from '../components/money/CompleteReconciliationDialog.vue';
import ImportStatementDialog from '../components/money/ImportStatementDialog.vue';
import { taka } from '../components/money/money-text';

/**
 * The reconciliation workspace (§5.17, UI-70, Phase 11).
 *
 * **Our ledger on the left, the bank's statement on the right**, aligned by
 * what the engine matched. Every row carries a word as well as an icon —
 * `Matched`, `Suggested`, `Not matched`, `Review` — because a status told only
 * in colour is a status a good number of people cannot read.
 *
 * **The screen never posts.** `Record it` opens the owning module's dialog,
 * `Open` goes to the document's own screen where Correct and Cancel live, and
 * this page's own calls only ever add or remove a link. When the owner comes
 * back from one of those, the workspace re-reads and the engine runs again —
 * so an entry posted a moment ago is already matched, with nothing to refresh.
 */
const route = useRoute();
const router = useRouter();
const session = useSession();

const workspace = ref<ReconciliationWorkspaceResponse | null>(null);
const drawerAccountId = ref<string | null>(null);
const loading = ref(true);
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const importing = ref(false);
const completing = ref(false);
const recording = ref<ReconciliationStatementRow | null>(null);
const pickedLedgerId = ref<string | null>(null);
const pickedStatementId = ref<string | null>(null);

const id = computed(() => String(route.params['id'] ?? ''));
const readOnly = computed(() => workspace.value?.status !== 'DRAFT');
const canPerform = computed(() => session.can('bank.reconciliation.perform'));
const canReopen = computed(() => session.can('bank.reconciliation.reopen'));

const suggestionByLedger = computed(() => {
  const map = new Map<string, MatchSuggestion>();
  for (const suggestion of workspace.value?.suggestions ?? []) {
    map.set(suggestion.journalLineId, suggestion);
  }
  return map;
});
const suggestionByStatement = computed(() => {
  const map = new Map<string, MatchSuggestion>();
  for (const suggestion of workspace.value?.suggestions ?? []) {
    map.set(suggestion.statementLineId, suggestion);
  }
  return map;
});
const conflictedLedger = computed(
  () => new Set((workspace.value?.conflicts ?? []).map((conflict) => conflict.journalLineId)),
);
const conflictedStatement = computed(
  () => new Set((workspace.value?.conflicts ?? []).map((conflict) => conflict.statementLineId)),
);

/** Clicking either side lights up the row it is tied to, or would be tied to. */
const highlighted = computed(() => {
  const ledgerId = pickedLedgerId.value;
  const statementId = pickedStatementId.value;
  const ledgerRow = workspace.value?.ledgerRows.find((row) => row.journalLineId === ledgerId);
  const statementRow = workspace.value?.statementRows.find(
    (row) => row.statementLineId === statementId,
  );

  return {
    ledger: new Set(
      [ledgerId, statementRow?.journalLineId, suggestionByStatement.value.get(statementId ?? '')?.journalLineId].filter(
        (value): value is string => typeof value === 'string',
      ),
    ),
    statement: new Set(
      [
        statementId,
        ledgerRow?.statementLineId,
        suggestionByLedger.value.get(ledgerId ?? '')?.statementLineId,
      ].filter((value): value is string => typeof value === 'string'),
    ),
  };
});

const canMatchPair = computed(
  () =>
    !readOnly.value &&
    canPerform.value &&
    pickedLedgerId.value !== null &&
    pickedStatementId.value !== null &&
    !isLinked(pickedLedgerId.value, 'LEDGER') &&
    !isLinked(pickedStatementId.value, 'STATEMENT'),
);

function isLinked(rowId: string | null, side: 'LEDGER' | 'STATEMENT'): boolean {
  if (rowId === null || workspace.value === null) return false;
  return side === 'LEDGER'
    ? workspace.value.ledgerRows.some((row) => row.journalLineId === rowId && row.matchState !== null)
    : workspace.value.statementRows.some(
        (row) => row.statementLineId === rowId && row.matchState !== null,
      );
}

function statusOf(state: string | null, conflicted: boolean, suggested: boolean): {
  icon: string;
  word: string;
  tone: string;
} {
  if (conflicted) return { icon: '⚠', word: 'Review', tone: 'warn' };
  if (state === 'AUTO') return { icon: '✓', word: 'Matched', tone: 'ok' };
  if (state === 'CONFIRMED' || state === 'MANUAL') return { icon: '✓', word: 'Matched by you', tone: 'ok' };
  if (state === 'OUTSTANDING') return { icon: '⏳', word: 'Not cleared yet', tone: 'wait' };
  if (state === 'NEEDS_REVIEW') return { icon: '⚠', word: 'Review', tone: 'warn' };
  if (suggested) return { icon: '?', word: 'Suggested', tone: 'maybe' };
  return { icon: '!', word: 'Not matched', tone: 'off' };
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNKNOWN', message: fallback };
}

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  try {
    workspace.value = await fetchReconciliation(token, id.value);
    const accounts = await fetchAccounts(token);
    drawerAccountId.value = accounts.accounts.find((account) => account.isDrawer)?.id ?? null;
  } catch (cause) {
    failure.value = describe(cause, 'Could not open this reconciliation');
  } finally {
    loading.value = false;
  }
}

async function act(work: () => Promise<ReconciliationWorkspaceResponse>): Promise<void> {
  busy.value = true;
  failure.value = null;
  try {
    workspace.value = await work();
    pickedLedgerId.value = null;
    pickedStatementId.value = null;
  } catch (cause) {
    failure.value = describe(cause, 'That did not work');
  } finally {
    busy.value = false;
  }
}

function link(
  statementLineId: string | null,
  journalLineId: string | null,
  state: 'CONFIRMED' | 'MANUAL' | 'REJECTED' | 'NEEDS_REVIEW' | 'OUTSTANDING',
): void {
  const token = session.accessToken.value;
  if (token === null) return;

  void act(() => saveMatch(token, id.value, { statementLineId, journalLineId, state }));
}

function unlink(matchId: string): void {
  const token = session.accessToken.value;
  if (token === null) return;

  void act(() => removeMatch(token, id.value, matchId));
}

function reopen(): void {
  const token = session.accessToken.value;
  const current = workspace.value;
  if (token === null || current === null) return;

  const reason = window.prompt('Why is this being reopened?');
  if (reason === null || reason.trim() === '') return;

  void act(() => reopenReconciliation(token, id.value, { reason: reason.trim(), version: current.version }));
}

/**
 * `Open` — the document's own screen, where Correct and Cancel live (UI-72).
 *
 * Reconciliation names the document; the module that owns it does the work.
 */
function openSource(row: ReconciliationLedgerRow): void {
  const type = row.sourceType;
  const target = type.startsWith('SALE') || type.startsWith('CUSTOMER_RECEIPT')
    ? '/sales'
    : type.startsWith('PURCHASE') || type.startsWith('SUPPLIER_PAYMENT')
      ? '/purchases'
      : type.startsWith('EXPENSE')
        ? '/expenses'
        : `/daybook?date=${row.businessDate}`;

  void router.push(target);
}

async function viewOriginal(fileId: string): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;

  try {
    const config = await loadConfig();
    const url = await openStatementFile(token, config.apiBaseUrl, id.value, fileId);
    window.open(url, '_blank');
  } catch (cause) {
    failure.value = describe(cause, 'Could not open the original statement');
  }
}

onMounted(load);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h1>{{ workspace?.accountName ?? 'Reconcile' }}</h1>
        <p class="sher-bn">ব্যাংকের কাগজের সাথে দোকানের হিসাব মিলিয়ে দেখুন</p>
      </div>
      <div class="head-actions">
        <Button text icon="pi pi-arrow-left" label="Back" @click="router.back()" />
        <button
          v-if="!readOnly && canPerform"
          type="button"
          class="btn btn-ghost"
          @click="importing = true"
        >
          Upload statement
        </button>
        <button
          v-if="!readOnly && canPerform"
          type="button"
          class="btn btn-primary"
          :disabled="busy"
          @click="completing = true"
        >
          Finish
        </button>
        <button v-if="readOnly && canReopen" type="button" class="btn btn-ghost" @click="reopen">
          Reopen
        </button>
      </div>
    </header>

    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <template v-if="workspace">
      <p v-if="workspace.status === 'REVIEW_REQUIRED'" class="banner warn">
        <strong>Review required.</strong>
        {{ workspace.changedSinceCompletion.length }} of the entries signed off here have been
        changed since:
        {{ workspace.changedSinceCompletion.map((row) => row.sourceNumber).join(', ') }}
      </p>
      <p v-else-if="workspace.status === 'COMPLETED'" class="banner done">
        <strong>Signed off</strong> on {{ workspace.completedAt?.slice(0, 10) }}
        <span v-if="workspace.completedByName">by {{ workspace.completedByName }}</span>.
        Reopen it to change anything.
      </p>

      <!-- The sticky summary: every figure and every count, always in view. -->
      <div class="summary">
        <div class="figures">
          <span><em>Statement opening</em>{{ taka(workspace.summary.statementOpeningMinor ?? 0) }}</span>
          <span><em>Statement closing</em>{{ taka(workspace.summary.statementClosingMinor ?? 0) }}</span>
          <span><em>Our matched balance</em>{{ taka(workspace.summary.reconciledBalanceMinor) }}</span>
          <span :class="{ off: workspace.summary.differenceMinor !== 0 }">
            <em>Difference</em>{{ taka(workspace.summary.differenceMinor) }}
          </span>
        </div>
        <div class="counts">
          <span>✓ {{ workspace.summary.autoMatched }} matched</span>
          <span>✓ {{ workspace.summary.manualMatched }} by you</span>
          <span>? {{ workspace.summary.suggested }} suggested</span>
          <span>! {{ workspace.summary.statementOnly }} on statement only</span>
          <span>! {{ workspace.summary.ledgerOnly }} ours only</span>
          <span>⏳ {{ workspace.summary.outstanding }} not cleared</span>
          <span>⚠ {{ workspace.summary.conflicts }} conflicts</span>
          <span>⚠ {{ workspace.summary.needsReview }} to review</span>
        </div>
        <ul v-if="workspace.summary.blockers.length > 0" class="blockers">
          <li v-for="blocker in workspace.summary.blockers" :key="blocker">{{ blocker }}</li>
        </ul>
      </div>

      <p v-if="workspace.files.length > 0" class="files">
        <span v-for="file in workspace.files" :key="file.fileId">
          <button type="button" class="btn btn-ghost small" @click="viewOriginal(file.fileId)">
            View original — {{ file.fileName }}
          </button>
        </span>
      </p>

      <div v-if="canMatchPair" class="pair-bar">
        One row picked on each side.
        <button type="button" class="btn btn-primary small" :disabled="busy" @click="link(pickedStatementId, pickedLedgerId, 'MANUAL')">
          Match these two
        </button>
      </div>

      <div class="panes">
        <!-- ---------------------------------------------------- our ledger -->
        <AppCard>
          <h2 class="pane-title">Our records <span>দোকানের হিসাব</span></h2>

          <EmptyState v-if="workspace.ledgerRows.length === 0" icon="pi-list" title="Nothing in this range">
            No money moved through this account between these dates.
          </EmptyState>

          <ul v-else class="rows">
            <li
              v-for="row in workspace.ledgerRows"
              :key="row.journalLineId"
              :class="[
                'row',
                statusOf(row.matchState, conflictedLedger.has(row.journalLineId), suggestionByLedger.has(row.journalLineId)).tone,
                { picked: pickedLedgerId === row.journalLineId, lit: highlighted.ledger.has(row.journalLineId) },
              ]"
              @click="pickedLedgerId = pickedLedgerId === row.journalLineId ? null : row.journalLineId"
            >
              <div class="row-main">
                <span class="date">{{ row.businessDate }}</span>
                <span class="what">{{ row.sourceNumber }}<em>{{ row.sourceType.replace(/_/g, ' ').toLowerCase() }}</em></span>
                <span class="amount" :class="{ out: row.amountMinor < 0 }">{{ taka(row.amountMinor) }}</span>
              </div>

              <div class="row-status">
                <span class="tag">
                  {{ statusOf(row.matchState, conflictedLedger.has(row.journalLineId), suggestionByLedger.has(row.journalLineId)).icon }}
                  {{ statusOf(row.matchState, conflictedLedger.has(row.journalLineId), suggestionByLedger.has(row.journalLineId)).word }}
                </span>

                <template v-if="!readOnly && canPerform">
                  <button
                    v-if="row.matchId !== null"
                    type="button"
                    class="btn btn-ghost small"
                    :disabled="busy"
                    @click.stop="unlink(row.matchId)"
                  >
                    Undo
                  </button>
                  <button
                    v-else-if="row.matchState === null"
                    type="button"
                    class="btn btn-ghost small"
                    :disabled="busy"
                    @click.stop="link(null, row.journalLineId, 'OUTSTANDING')"
                  >
                    Not cleared yet
                  </button>
                </template>
                <button type="button" class="btn btn-ghost small" @click.stop="openSource(row)">
                  Open
                </button>
              </div>

              <!-- Why the engine thinks these two are the same transaction. -->
              <div v-if="suggestionByLedger.get(row.journalLineId)" class="reasons">
                <span
                  v-for="reason in suggestionByLedger.get(row.journalLineId)?.reasons ?? []"
                  :key="reason.label"
                  :class="{ good: reason.ok }"
                >
                  {{ reason.label }}: {{ reason.detail }}
                </span>
                <template v-if="!readOnly && canPerform">
                  <button
                    type="button"
                    class="btn btn-primary small"
                    :disabled="busy"
                    @click.stop="link(suggestionByLedger.get(row.journalLineId)?.statementLineId ?? null, row.journalLineId, 'CONFIRMED')"
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost small"
                    :disabled="busy"
                    @click.stop="link(suggestionByLedger.get(row.journalLineId)?.statementLineId ?? null, row.journalLineId, 'REJECTED')"
                  >
                    Not the same
                  </button>
                </template>
              </div>
            </li>
          </ul>
        </AppCard>

        <!-- ----------------------------------------------- the bank's rows -->
        <AppCard>
          <h2 class="pane-title">Bank statement <span>ব্যাংকের কাগজ</span></h2>

          <EmptyState
            v-if="workspace.statementRows.length === 0"
            icon="pi-file"
            title="No statement loaded"
          >
            Upload the PDF the bank gave you, or tick your own entries against the paper.
          </EmptyState>

          <ul v-else class="rows">
            <li
              v-for="row in workspace.statementRows"
              :key="row.statementLineId"
              :class="[
                'row',
                statusOf(row.matchState, conflictedStatement.has(row.statementLineId), suggestionByStatement.has(row.statementLineId)).tone,
                { picked: pickedStatementId === row.statementLineId, lit: highlighted.statement.has(row.statementLineId) },
              ]"
              @click="pickedStatementId = pickedStatementId === row.statementLineId ? null : row.statementLineId"
            >
              <div class="row-main">
                <span class="date">{{ row.businessDate }}</span>
                <span class="what">{{ row.description }}<em v-if="row.reference">{{ row.reference }}</em></span>
                <span class="amount" :class="{ out: row.amountMinor < 0 }">{{ taka(row.amountMinor) }}</span>
              </div>

              <div class="row-status">
                <span class="tag">
                  {{ statusOf(row.matchState, conflictedStatement.has(row.statementLineId), suggestionByStatement.has(row.statementLineId)).icon }}
                  {{ statusOf(row.matchState, conflictedStatement.has(row.statementLineId), suggestionByStatement.has(row.statementLineId)).word }}
                </span>

                <template v-if="!readOnly && canPerform">
                  <button
                    v-if="row.matchId !== null"
                    type="button"
                    class="btn btn-ghost small"
                    :disabled="busy"
                    @click.stop="unlink(row.matchId)"
                  >
                    Undo
                  </button>
                  <button
                    v-else-if="row.matchState === null"
                    type="button"
                    class="btn btn-primary small"
                    :disabled="busy"
                    @click.stop="recording = row"
                  >
                    Record it
                  </button>
                  <button
                    v-if="row.matchState === null"
                    type="button"
                    class="btn btn-ghost small"
                    :disabled="busy"
                    @click.stop="link(row.statementLineId, null, 'NEEDS_REVIEW')"
                  >
                    Look at later
                  </button>
                </template>
              </div>

              <p v-if="row.possibleWrongAccount" class="warn-line">
                ⚠ Possible wrong account — {{ row.possibleWrongAccount.sourceNumber }} of the same
                amount is on {{ row.possibleWrongAccount.accountName }}. Open it and correct the
                account if that is what happened.
              </p>
            </li>
          </ul>
        </AppCard>
      </div>
    </template>

    <ImportStatementDialog
      v-if="importing"
      :reconciliation-id="id"
      @close="importing = false"
      @imported="(next) => { workspace = next; importing = false; }"
    />

    <AddMissingEntryDialog
      v-if="recording !== null && workspace !== null"
      :row="recording"
      :account-id="workspace.accountId"
      :drawer-account-id="drawerAccountId"
      @close="recording = null"
      @posted="() => { recording = null; void load(); }"
    />

    <CompleteReconciliationDialog
      v-if="completing && workspace !== null"
      :workspace="workspace"
      @close="completing = false"
      @completed="(next) => { workspace = next; completing = false; }"
    />
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4, 16px);
}

.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sher-space-4, 16px);
  flex-wrap: wrap;
}

.page-head h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
}

.page-head p {
  margin: 2px 0 0;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.banner {
  margin: 0;
  padding: var(--sher-space-3, 12px);
  border-radius: 8px;
  font-size: 13px;
  background: var(--sher-surface-muted, #f5f5f4);
}

.banner.warn {
  background: #fef3c7;
}

.summary {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--sher-space-3, 12px);
  border-radius: 8px;
  background: var(--sher-surface, #fff);
  border: 1px solid var(--sher-border, #e7e5e4);
}

.figures {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sher-space-4, 16px);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.figures em {
  display: block;
  font-style: normal;
  font-weight: 400;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.figures .off {
  color: var(--sher-danger, #b91c1c);
}

.counts {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: var(--sher-text-muted);
}

.blockers {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--sher-danger, #b91c1c);
}

.files {
  margin: 0;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.pair-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px;
  border-radius: 8px;
  background: #ecfdf5;
  font-size: 13px;
}

.panes {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sher-space-4, 16px);
  align-items: start;
}

@media (max-width: 900px) {
  .panes {
    grid-template-columns: 1fr;
  }
}

.pane-title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 700;
}

.pane-title span {
  font-size: 11px;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 62vh;
  overflow-y: auto;
}

.row {
  padding: 8px;
  border: 1px solid var(--sher-border, #e7e5e4);
  border-left-width: 4px;
  border-radius: 6px;
  cursor: pointer;
}

.row.ok { border-left-color: #16a34a; }
.row.maybe { border-left-color: #d97706; }
.row.off { border-left-color: #9ca3af; }
.row.warn { border-left-color: #b91c1c; }
.row.wait { border-left-color: #2563eb; }

.row.picked {
  outline: 2px solid var(--sher-accent, #0d9488);
}

.row.lit {
  background: #f0fdfa;
}

.row-main {
  display: grid;
  grid-template-columns: 84px 1fr auto;
  gap: 8px;
  align-items: baseline;
  font-size: 13px;
}

.date {
  color: var(--sher-text-muted);
  font-size: 12px;
}

.what em {
  display: block;
  font-style: normal;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.amount {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.amount.out {
  color: #b91c1c;
}

.row-status {
  margin-top: 4px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  font-size: 12px;
}

.tag {
  font-weight: 600;
}

.reasons {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.reasons .good {
  color: #15803d;
}

.warn-line {
  margin: 6px 0 0;
  font-size: 11px;
  color: #92400e;
}

.small {
  font-size: 11px;
  padding: 2px 8px;
}
</style>
