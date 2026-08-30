<script setup lang="ts">
import type {
  ReconciliationWorkspaceResponse,
  StatementLineDraft,
  StatementPreviewResponse,
} from '@sher/core-contracts';
import Dialog from 'primevue/dialog';
import { computed, ref } from 'vue';

import { ApiError } from '../../api/client';
import { confirmStatement, uploadStatement } from '../../api/reconciliation';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';
import { taka } from './money-text';

/**
 * Reading the bank's PDF into a reconciliation (§5.17, owner decision
 * 2026-08-30).
 *
 * **Two steps, and the owner is the second one.** The file is uploaded and
 * parsed, then every row it found is shown in a grid that can be edited before
 * anything is imported. A statement the parser read perfectly still goes
 * through this screen, because the owner is the person who knows whether it did.
 *
 * A scan with no text in it imports nothing and says so: the file is kept as
 * evidence and the reconciliation continues by hand against the paper.
 */
const props = defineProps<{ reconciliationId: string }>();
const emit = defineEmits<{
  close: [];
  imported: [workspace: ReconciliationWorkspaceResponse];
}>();

const session = useSession();
const preview = ref<StatementPreviewResponse | null>(null);
const rows = ref<StatementLineDraft[]>([]);
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const unreadable = computed(() => preview.value?.parseStatus === 'UNREADABLE');
const totalMinor = computed(() => rows.value.reduce((sum, row) => sum + row.amountMinor, 0));

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNKNOWN', message: fallback };
}

async function pick(event: Event): Promise<void> {
  const token = session.accessToken.value;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (token === null || file === undefined) return;

  busy.value = true;
  failure.value = null;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);

    const result = await uploadStatement(token, props.reconciliationId, {
      fileName: file.name,
      contentBase64: btoa(binary),
    });
    preview.value = result;
    rows.value = result.lines.map((line) => ({ ...line }));
  } catch (cause) {
    failure.value = describe(cause, 'Could not read that file');
  } finally {
    busy.value = false;
  }
}

/** Editing a row marks it, so the record keeps "the bank said" apart from "we decided". */
function edited(row: StatementLineDraft): void {
  row.editedByUser = true;
}

function remove(index: number): void {
  rows.value.splice(index, 1);
}

function amountOf(row: StatementLineDraft): string {
  return String(row.amountMinor / 100);
}

function setAmount(row: StatementLineDraft, value: string): void {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return;
  row.amountMinor = Math.round(parsed * 100);
  edited(row);
}

async function importRows(): Promise<void> {
  const token = session.accessToken.value;
  const file = preview.value;
  if (token === null || file === null) return;

  busy.value = true;
  failure.value = null;
  try {
    const workspace = await confirmStatement(token, props.reconciliationId, {
      fileId: file.fileId,
      lines: rows.value,
      openingBalanceMinor: file.openingBalanceMinor,
      closingBalanceMinor: file.closingBalanceMinor,
    });
    emit('imported', workspace);
  } catch (cause) {
    failure.value = describe(cause, 'Could not import those rows');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    :visible="true"
    modal
    header="Bank statement — ব্যাংকের স্টেটমেন্ট"
    :style="{ width: 'min(60rem, 96vw)' }"
    @update:visible="emit('close')"
  >
    <div class="import">
      <ErrorNotice v-if="failure !== null" :code="failure.code" :message="failure.message" />

      <div v-if="preview === null" class="field">
        <label for="statement-file">
          Choose the statement <span>ব্যাংক থেকে নেওয়া পিডিএফ ফাইল</span>
        </label>
        <input id="statement-file" type="file" accept="application/pdf" :disabled="busy" @change="pick" />
        <p class="hint">
          The file is kept exactly as it is, so it can always be opened again beside the numbers
          it produced.
        </p>
      </div>

      <template v-else>
        <p class="summary">
          <strong>{{ preview.fileName }}</strong>
          <span v-if="preview.fromDate">{{ preview.fromDate }} → {{ preview.toDate }}</span>
          <span v-if="preview.closingBalanceMinor !== null">
            Closing on the statement: {{ taka(preview.closingBalanceMinor) }}
          </span>
        </p>

        <p v-if="unreadable" class="unreadable">
          Nothing could be read from this file — it is most likely a scan or a photo. It has been
          kept as your evidence; carry on and tick your own entries against the paper statement.
        </p>

        <p v-else-if="preview.parseStatus === 'PARTIAL'" class="partial">
          Some rows need a look. Check the ones marked below, fix anything wrong, and remove
          anything that is not a transaction.
        </p>

        <div v-if="rows.length > 0" class="grid-scroll">
          <table class="rows">
            <thead>
              <tr>
                <th>Date</th>
                <th>What the bank wrote</th>
                <th>Reference</th>
                <th class="num">Amount</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in rows" :key="row.lineNo" :class="{ touched: row.editedByUser }">
                <td><input v-model="row.businessDate" @change="edited(row)" /></td>
                <td><input v-model="row.description" @change="edited(row)" /></td>
                <td><input v-model="row.reference" @change="edited(row)" /></td>
                <td class="num">
                  <input
                    :value="amountOf(row)"
                    inputmode="decimal"
                    @change="setAmount(row, ($event.target as HTMLInputElement).value)"
                  />
                </td>
                <td>
                  <button type="button" class="btn btn-ghost small" @click="remove(index)">
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <ul v-if="preview.problems.length > 0" class="problems">
          <li v-for="problem in preview.problems" :key="problem.lineNo">
            Line {{ problem.lineNo }} could not be read ({{ problem.reason.replace(/_/g, ' ').toLowerCase() }}):
            <span class="raw">{{ problem.text }}</span>
          </li>
        </ul>

        <p class="totals">
          {{ rows.length }} rows · net {{ taka(totalMinor) }}
          <span class="note">Money in is positive, money out negative.</span>
        </p>
      </template>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          {{ unreadable ? 'Carry on by hand' : 'Cancel' }}
        </button>
        <button
          v-if="preview !== null && rows.length > 0"
          type="button"
          class="btn btn-primary"
          :disabled="busy"
          @click="importRows"
        >
          {{ busy ? 'Importing…' : `Import ${rows.length} rows` }}
        </button>
      </div>
    </div>
  </Dialog>
</template>

<style scoped>
.import {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-3, 12px);
}

.hint,
.note {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.summary {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--sher-space-3, 12px);
  font-size: 13px;
}

.unreadable,
.partial {
  margin: 0;
  padding: var(--sher-space-3, 12px);
  border-radius: 8px;
  font-size: 13px;
  background: var(--sher-surface-muted, #f5f5f4);
}

.grid-scroll {
  overflow-x: auto;
  max-height: 46vh;
  overflow-y: auto;
}

.rows {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.rows th,
.rows td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--sher-border, #e7e5e4);
  text-align: left;
}

.rows input {
  width: 100%;
  border: 1px solid transparent;
  background: transparent;
  padding: 3px 4px;
  font: inherit;
}

.rows input:focus {
  border-color: var(--sher-border, #e7e5e4);
  background: #fff;
}

.rows tr.touched td:first-child {
  border-left: 3px solid var(--sher-accent, #0d9488);
}

.num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.problems {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--sher-text-muted);
}

.raw {
  font-family: ui-monospace, monospace;
}

.totals {
  margin: 0;
  font-size: 13px;
  display: flex;
  gap: var(--sher-space-3, 12px);
  align-items: baseline;
}

.small {
  font-size: 11px;
  padding: 2px 8px;
}
</style>
