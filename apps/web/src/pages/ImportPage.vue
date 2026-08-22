<script setup lang="ts">
import { IMPORT_COLUMNS, importTemplate } from '@sher/core-domain';
import type { ImportPreviewResponse, ImportTypeValue } from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { commitImport, previewImport } from '../api/imports';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * Guided onboarding import (§5.6).
 *
 * One screen, four steps in the order a shopkeeper does them: choose what is
 * being imported, download the template, choose the filled-in file, look at
 * what it would do — and only then Import. The preview is not decoration: §5.6
 * requires it, and it is where a wrong row is cheap to fix, because nothing has
 * been written yet.
 *
 * Nothing here decides anything about the data. The columns come from the
 * domain's own template definition, every message on every row comes from the
 * server, and Import posts the same text that was previewed (B8).
 */
const clock = new SystemClock();
const session = useSession();
const route = useRoute();
const router = useRouter();

interface ImportKind {
  readonly type: ImportTypeValue;
  readonly label: string;
  readonly labelBn: string;
  readonly permission: string;
  readonly help: string;
}

/**
 * What can be imported today. Opening receivables, payables, cash and bank are
 * named by §5.6 too and arrive with the Phase 4 posting services that can give
 * them a journal entry — they are absent rather than shown and refused (UI-09).
 */
const KINDS: readonly ImportKind[] = [
  {
    type: 'PRODUCTS',
    label: 'Products',
    labelBn: 'পণ্যের তালিকা',
    permission: 'catalog.product.create',
    help: 'Your product list with prices. Units, brands and categories must already exist.',
  },
  {
    type: 'CUSTOMERS',
    label: 'Customers',
    labelBn: 'কাস্টমারের তালিকা',
    permission: 'party.customer.create',
    help: 'Each customer needs a phone number, and no two customers may share one.',
  },
  {
    type: 'SUPPLIERS',
    label: 'Suppliers',
    labelBn: 'সরবরাহকারীর তালিকা',
    permission: 'party.supplier.create',
    help: 'The businesses you buy from.',
  },
  {
    type: 'OPENING_STOCK',
    label: 'Opening stock',
    labelBn: 'শুরুর স্টক',
    permission: 'catalog.product.create',
    help: 'How much of each product you hold right now. Import the products first.',
  },
];

const kinds = computed(() => KINDS.filter((kind) => session.can(kind.permission)));

const type = ref<ImportTypeValue>(kindFromRoute());
const fileName = ref<string | null>(null);
const csv = ref('');
const preview = ref<ImportPreviewResponse | null>(null);
const result = ref<{ rows: number } | null>(null);
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);

/**
 * One id per file, generated when the file is chosen and reused on every retry
 * (UI-34, §5.6). Pressing Import twice on a slow connection must import once.
 */
const operationId = ref(Ulid.generate(clock));

function kindFromRoute(): ImportTypeValue {
  const asked = String(route.query['type'] ?? '');
  const known = KINDS.find((kind) => kind.type === asked);
  return known?.type ?? kinds.value[0]?.type ?? 'PRODUCTS';
}

const current = computed(() => KINDS.find((kind) => kind.type === type.value) ?? KINDS[0]);
const columns = computed(() => IMPORT_COLUMNS[type.value]);
const canImport = computed(
  () => preview.value !== null && preview.value.totalRows > 0 && preview.value.invalidRows === 0,
);

// Changing what is being imported abandons the file with it: a customer file
// previewed as products would be nonsense, and silently keeping it is worse.
watch(type, () => {
  clearFile();
  void router.replace({ query: { type: type.value } });
});

function clearFile(): void {
  fileName.value = null;
  csv.value = '';
  preview.value = null;
  result.value = null;
  error.value = null;
}

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

function downloadTemplate(): void {
  const blob = new Blob([importTemplate(type.value)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `sher-${type.value.toLowerCase()}-template.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

async function chooseFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;

  clearFile();
  fileName.value = file.name;
  csv.value = await file.text();
  // A new file is a new intent, so it gets its own operation id.
  operationId.value = Ulid.generate(clock);
  await runPreview();
}

async function runPreview(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    preview.value = await previewImport(session.accessToken.value ?? '', type.value, csv.value);
  } catch (cause) {
    preview.value = null;
    error.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

async function runImport(): Promise<void> {
  busy.value = true;
  error.value = null;
  try {
    const done = await commitImport(
      session.accessToken.value ?? '',
      type.value,
      csv.value,
      operationId.value,
    );
    result.value = { rows: done.imported };
    preview.value = null;
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

function cellOf(values: Record<string, string>, key: string): string {
  const value = values[key] ?? '';
  return value === '' ? '—' : value;
}

/** Where the imported records now are, so the shopkeeper can go and see them. */
const destination = computed(() =>
  type.value === 'CUSTOMERS'
    ? { label: 'Open Customers', to: '/parties?role=CUSTOMER' }
    : type.value === 'SUPPLIERS'
      ? { label: 'Open Suppliers', to: '/parties?role=SUPPLIER' }
      : { label: 'Open Products', to: '/products' },
);
</script>

<template>
  <AppShell
    title="Import data"
    :breadcrumb="['Dashboard', 'Import data']"
    help-bn="পুরোনো খাতা বা এক্সেল ফাইল থেকে একবারে সব তুলে আনুন"
  >
    <AppCard v-if="kinds.length === 0" title="Nothing to import">
      <p class="muted">
        Importing creates products, customers or suppliers, and your role does not include
        creating them. Ask the owner for the permission you need.
      </p>
    </AppCard>

    <template v-else>
      <AppCard title="1. What are you importing?">
        <div class="filters">
          <div class="field">
            <label for="import-type">Type — কী তুলছেন</label>
            <Select
              v-model="type"
              input-id="import-type"
              :options="kinds"
              option-label="label"
              option-value="type"
              append-to="self"
              fluid
            />
          </div>
        </div>
        <p class="muted">{{ current?.help }}</p>
      </AppCard>

      <AppCard title="2. Download the template">
        <p class="muted">
          Fill this file in Excel and keep the first row exactly as it is. Every column below is
          part of the template; the ones marked required cannot be left empty.
        </p>
        <div class="template-columns">
          <div v-for="column in columns" :key="column.key" class="template-column">
            <span class="column-name">
              {{ column.header }}
              <span v-if="column.required" class="required" aria-label="required">*</span>
            </span>
            <span class="column-help">{{ column.help }}</span>
          </div>
        </div>
        <Button
          label="Download template"
          icon="pi pi-download"
          severity="secondary"
          @click="downloadTemplate"
        />
      </AppCard>

      <AppCard title="3. Choose your filled-in file">
        <div class="file-row">
          <label class="btn btn-ghost file-button" for="import-file">
            <i class="pi pi-file" aria-hidden="true" />
            Choose CSV file
          </label>
          <input
            id="import-file"
            type="file"
            accept=".csv,text/csv"
            class="file-input"
            @change="chooseFile"
          />
          <span v-if="fileName !== null" class="file-name">{{ fileName }}</span>
        </div>
      </AppCard>

      <p v-if="busy" class="notice" role="status" aria-busy="true">Reading the file…</p>

      <AppCard v-if="error !== null" title="That file could not be imported">
        <ErrorNotice :code="error.code" :message="error.message" />
      </AppCard>

      <AppCard v-if="result !== null" title="Imported">
        <p class="notice is-ok" role="status">
          {{ result.rows }} row{{ result.rows === 1 ? '' : 's' }} imported.
        </p>
        <Button
          :label="destination.label"
          icon="pi pi-arrow-right"
          severity="secondary"
          @click="router.push(destination.to)"
        />
      </AppCard>

      <AppCard v-if="preview !== null" title="4. Check what will happen">
        <p v-if="preview.missingColumns.length > 0" class="notice is-bad" role="alert">
          This file is missing the {{ preview.missingColumns.join(', ') }} column{{
            preview.missingColumns.length > 1 ? 's' : ''
          }}. Download the template above and start from it.
        </p>

        <template v-else>
          <p class="summary" role="status">
            <strong>{{ preview.totalRows }}</strong> rows ·
            <strong class="ok">{{ preview.validRows }}</strong> ready ·
            <strong :class="preview.invalidRows > 0 ? 'bad' : ''">{{ preview.invalidRows }}</strong>
            with problems
          </p>
          <p v-if="preview.invalidRows > 0" class="notice is-bad" role="alert">
            Nothing is imported until every row is right — the whole file is saved together or not
            at all. Fix these rows in Excel and choose the file again.
          </p>

          <div class="table-scroll">
            <table class="table">
              <thead>
                <tr>
                  <th scope="col" class="row-number">Row</th>
                  <th v-for="column in preview.columns" :key="column.key" scope="col">
                    {{ column.header }}
                  </th>
                  <th scope="col">Problem</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in preview.rows"
                  :key="row.rowNumber"
                  :class="{ 'is-bad': row.errors.length > 0 }"
                >
                  <td class="row-number">{{ row.rowNumber }}</td>
                  <td v-for="column in preview.columns" :key="column.key">
                    {{ cellOf(row.values, column.key) }}
                  </td>
                  <td>
                    <span v-if="row.errors.length === 0" class="ok">Ready</span>
                    <span v-for="problem in row.errors" :key="problem.column + problem.message" class="bad">
                      {{ problem.column }}: {{ problem.message }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <Button
            :label="`Import ${preview.validRows} row${preview.validRows === 1 ? '' : 's'}`"
            icon="pi pi-upload"
            :disabled="!canImport || busy"
            @click="runImport"
          />
        </template>
      </AppCard>
    </template>
  </AppShell>
</template>

<style scoped>
.muted {
  color: var(--sher-text-muted);
  font-size: 13px;
  margin: 0 0 12px;
}

.template-columns {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px 16px;
  margin-bottom: 12px;
}

.template-column {
  display: flex;
  flex-direction: column;
}

.column-name {
  font-size: 13px;
  font-weight: 600;
}

.required {
  color: var(--sher-bad);
}

.column-help {
  color: var(--sher-text-muted);
  font-size: 11px;
}

.file-row {
  align-items: center;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

/* The real input stays reachable by keyboard and screen reader; the label is
   what is seen, because a native file input cannot be styled to match. */
.file-input {
  height: 1px;
  opacity: 0;
  position: absolute;
  width: 1px;
}

.file-button {
  cursor: pointer;
}

.file-input:focus-visible + .file-name,
.file-input:focus-visible ~ .file-button {
  outline: 2px solid var(--sher-brand);
}

.file-name {
  font-size: 13px;
}

.summary {
  font-size: 13px;
  margin: 0 0 12px;
}

.ok {
  color: var(--sher-ok);
}

.bad {
  color: var(--sher-bad);
  display: block;
}

.table-scroll {
  margin-bottom: 12px;
  overflow-x: auto;
}

.row-number {
  text-align: right;
  width: 56px;
}

tr.is-bad td {
  background: var(--sher-bad-bg);
}
</style>
