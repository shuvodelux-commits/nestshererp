<script setup lang="ts">
import type { InvoiceSettings, SaleResponse } from '@sher/core-contracts';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../../api/client';
import { fetchImageDataUrl } from '../../api/images';
import { cancelSale, fetchInvoiceSettings, fetchSale } from '../../api/sales';
import { useSession } from '../../auth/session';
import ConfirmDialog from '../ConfirmDialog.vue';
import ErrorNotice from '../ErrorNotice.vue';
import { taka } from '../money/money-text';
import InvoiceDocument from './InvoiceDocument.vue';
import SalesReturnDialog from './SalesReturnDialog.vue';
import { printNode, saveNodeAsImage, shareNodeAsImage } from './invoice-output';

/**
 * What happens the moment a sale is completed (owner decision 2026-08-25).
 *
 * The invoice as it will be printed, with the **display-only** fields editable
 * beside it. §5.8 splits an invoice in two, and this dialog is that split made
 * visible: everything on the left is what the sale *did* and is shown read-only;
 * everything on the right is what the invoice *says* and can be corrected before
 * it is handed over.
 *
 * Changing a customer or product name here changes this invoice and nothing
 * else — not the customer record, not the product, not stock, cost, quantity,
 * payment or the ledger. Changing what was actually sold is `Edit Sale`, which
 * goes through the correction path (§2.5), and cancelling is a reversal, never
 * a delete.
 */
const props = defineProps<{ sale: SaleResponse }>();
const emit = defineEmits<{ close: []; updated: [sale: SaleResponse] }>();

const session = useSession();
const router = useRouter();

const settings = ref<InvoiceSettings | null>(null);
const logoDataUrl = ref<string | null>(null);
const template = ref<'A4' | 'THERMAL_80'>('A4');
/**
 * Which language this copy prints in.
 *
 * The shop's default lives in Settings, and this is the moment it can be
 * overridden: the same customer sometimes wants the Bangla চালান and the
 * supplier's office wants the English one, and nobody should have to change a
 * shop-wide setting to hand over one sheet. It resets to the default every time
 * the dialog opens, so the default stays the habit.
 */
const language = ref<'EN' | 'BN'>('EN');

/** The settings this copy is drawn with — the shop's, with the language chosen here. */
const sheetSettings = computed(() =>
  settings.value === null ? null : { ...settings.value, language: language.value },
);
const sheet = ref<HTMLElement | null>(null);
const saving = ref(false);
const confirmingCancel = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);


/**
 * The document as the form currently reads — not as it was last saved.
 *
 * The owner rule that every figure moves as it is typed applies to words too: a
 * preview that only catches up when Update Invoice is pressed is a preview
 * nobody can trust, and it is what makes someone print the wrong name. The
 * posted sale is untouched; only its presentation layer is overlaid, which is
 * exactly the split §5.8 draws between what a sale did and what it says.
 */
const previewSale = computed(() => props.sale);
const canEditSale = ref(session.can('sale.invoice.edit'));
const canVoid = ref(session.can('sale.invoice.void'));
/*
 * A return starts from the invoice it comes back from (owner decision
 * 2026-08-26) — there is no free-standing return screen. The list page under
 * Sales is where past returns are read, not where one is taken.
 */
const canReturn = ref(session.can('sales.return.create'));
const returning = ref(false);

onMounted(async () => {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    settings.value = await fetchInvoiceSettings(token);
    template.value = settings.value.defaultTemplate;
    language.value = settings.value.language;
    if (settings.value.hasLogo) {
      logoDataUrl.value = await fetchImageDataUrl('/api/v1/sales/invoice-logo', token);
    }
  } catch {
    settings.value = null;
  }
});

async function cancelThisSale(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  saving.value = true;
  failure.value = null;
  try {
    const updated = await cancelSale(token, props.sale.id, props.sale.version, null);
    emit('updated', updated);
  } catch (cause) {
    failure.value = describe(cause, 'Could not cancel this sale');
  } finally {
    saving.value = false;
  }
}

/**
 * The invoice is re-read after a return: its due has moved, and a preview still
 * showing the old figure is the thing that gets printed and handed over.
 */
async function onReturned(): Promise<void> {
  returning.value = false;
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    emit('updated', await fetchSale(token, props.sale.id));
  } catch {
    // The return posted; only the refresh failed. The list behind this dialog
    // re-reads on its own through `onDataChanged`.
  }
}

async function onConfirmCancel(): Promise<void> {
  confirmingCancel.value = false;
  await cancelThisSale();
}

function editSale(): void {
  /*
   * The correction path (§5.8, §2.5): quantity, price, product and payment are
   * transaction facts, so they are changed where a cart is changed — the
   * counter — and the corrected sale replaces this one by reversal.
   */
  emit('close');
  void router.push({ name: 'pos', query: { edit: props.sale.id } });
}

function print(which: 'A4' | 'THERMAL_80'): void {
  template.value = which;
  requestAnimationFrame(() => {
    if (sheet.value !== null) printNode(sheet.value, which);
  });
}

async function saveImage(): Promise<void> {
  if (sheet.value === null) return;
  saving.value = true;
  failure.value = null;
  try {
    await saveNodeAsImage(sheet.value, `${props.sale.number}.jpg`);
  } catch (cause) {
    failure.value = describe(cause, 'Could not save this invoice as a picture');
  } finally {
    saving.value = false;
  }
}

async function share(): Promise<void> {
  if (sheet.value === null) return;
  saving.value = true;
  failure.value = null;
  try {
    await shareNodeAsImage(sheet.value, `${props.sale.number}.jpg`);
  } catch (cause) {
    // A share the person cancelled is not a failure worth a red banner.
    if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
      failure.value = describe(cause, 'Could not share this invoice');
    }
  } finally {
    saving.value = false;
  }
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  if (cause instanceof ApiError) return { code: cause.code, message: cause.message };
  /*
   * A failure that never reached the server still has to say what went wrong.
   * The printing and picture paths run entirely in the browser, and reporting
   * every one of them as `UNKNOWN` left the owner with a red box and nothing to
   * tell anyone (2026-08-26).
   */
  if (cause instanceof Error) return { code: 'BROWSER', message: cause.message };
  return { code: 'UNKNOWN', message: fallback };
}
</script>

<template>
  <!--
    Closable from the corner as well as from New Sale: the invoice is posted the
    moment this opens, so nothing is lost by shutting it, and a modal with no ×
    reads as a trap.
  -->
  <Dialog
    visible
    modal
    :style="{ width: 'min(72rem, 96vw)' }"
    :header="`Invoice ${sale.number}`"
    @update:visible="emit('close')"
  >
    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div class="preview">
      <div class="preview__paperwrap">
        <div class="preview__switches">
          <div class="seg">
            <button
              type="button"
              :class="{ 'seg--on': language === 'BN' }"
              @click="language = 'BN'"
            >
              বাংলা
            </button>
            <button
              type="button"
              :class="{ 'seg--on': language === 'EN' }"
              @click="language = 'EN'"
            >
              English
            </button>
          </div>
          <div class="seg">
            <button
              type="button"
              :class="{ 'seg--on': template === 'A4' }"
              @click="template = 'A4'"
            >
              A4
            </button>
            <button
              type="button"
              :class="{ 'seg--on': template === 'THERMAL_80' }"
              @click="template = 'THERMAL_80'"
            >
              {{ settings?.thermalPaper ?? '80mm' }}
            </button>
          </div>
          <span class="preview__default">
            Default: {{ settings?.language === 'BN' ? 'বাংলা' : 'English' }}
          </span>
        </div>
      <div class="preview__sheet">
        <div ref="sheet" class="preview__paper">
          <InvoiceDocument
            v-if="sheetSettings"
            :sale="previewSale"
            :settings="sheetSettings"
            :template="template"
            :logo-data-url="logoDataUrl"
          />
        </div>
      </div>
      </div>

    </div>

    <template #footer>
      <div class="preview__actions">
        <Button v-if="canEditSale" label="Edit Sale" text @click="editSale" />
        <Button
          v-if="canReturn && sale.status === 'POSTED'"
          label="Return"
          text
          @click="returning = true"
        />
        <Button
          v-if="canVoid && sale.status === 'POSTED'"
          label="Cancel Sale"
          text
          severity="danger"
          :disabled="saving"
          @click="confirmingCancel = true"
        />
        <span class="preview__spacer" />
        <Button label="Thermal Print" text @click="print('THERMAL_80')" />
        <Button label="Save as JPG" text @click="saveImage" />
        <Button label="Share" text @click="share" />
        <Button label="Print A4" @click="print('A4')" />
        <Button label="New Sale" severity="success" @click="emit('close')" />
      </div>
    </template>
  </Dialog>

  <SalesReturnDialog
    v-if="returning"
    :sale-id="sale.id"
    @close="returning = false"
    @returned="onReturned"
  />

  <ConfirmDialog
    v-if="confirmingCancel"
    title="Cancel this sale?"
    message="The goods go back on the shelf and the money comes back out of the day. The invoice keeps its number and stays visible, marked cancelled."
    :amount-minor="sale.grandTotalMinor"
    danger
    confirm-label="Cancel the sale"
    confirm-label-bn="বিক্রি বাতিল করুন"
    :busy="saving"
    :error="failure"
    @cancel="confirmingCancel = false"
    @confirm="onConfirmCancel"
  />
</template>

<style scoped>
.preview {
  display: block;
}

@media (max-width: 60rem) {
  .preview {
    grid-template-columns: minmax(0, 1fr);
  }
}

.preview__paperwrap {
  min-width: 0;
}

.preview__switches {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.seg {
  display: flex;
  padding: 2px;
  border: 1px solid var(--sher-line);
  border-radius: 8px;
  background: var(--sher-sunken);
}

.seg button {
  border: none;
  background: transparent;
  color: var(--sher-text-muted);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

.seg--on {
  background: var(--sher-raised);
  color: var(--sher-text);
  font-weight: 600;
  box-shadow: var(--sher-shadow-sm, 0 1px 2px rgb(15 23 42 / 8%));
}

.preview__default {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.preview__sheet {
  background: var(--p-surface-100);
  padding: 0.75rem;
  border-radius: 0.5rem;
  overflow-x: auto;
  max-height: 65vh;
  overflow-y: auto;
}

/*
 * The paper is exactly as wide as the sheet on it — `fit-content`, not the
 * width of the scroller. This element is what Save as JPG and Share capture,
 * and a block div stretches to its container while the document inside stops at
 * 210mm, so every picture came out with a wide empty band down its right side
 * (owner-reported, 2026-08-26).
 */
.preview__paper {
  width: fit-content;
  margin-inline: auto;
  background: #fff;
  box-shadow: 0 1px 6px rgb(0 0 0 / 15%);
}

.preview__side {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 65vh;
  overflow-y: auto;
}

.preview__facts {
  display: flex;
  gap: 0.75rem;
  align-items: baseline;
  flex-wrap: wrap;
  margin: 0;
}

.preview__facts strong {
  font-size: 1.15rem;
}

.preview__due {
  color: #b91c1c;
}

.preview__hint {
  margin: 0;
  font-size: 0.8rem;
  opacity: 0.75;
}

.preview__fields {
  border: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.8rem;
}

.preview__group {
  margin: 0.5rem 0 0;
  font-weight: 600;
  font-size: 0.8rem;
}

.preview__extra {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 0.35rem;
}

.preview__actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.preview__spacer {
  flex: 1;
}
</style>
