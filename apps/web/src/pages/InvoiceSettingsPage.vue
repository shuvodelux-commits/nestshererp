<script setup lang="ts">
import type { InvoiceSettings } from '@sher/core-contracts';
import Button from 'primevue/button';
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import Textarea from 'primevue/textarea';
import ToggleSwitch from 'primevue/toggleswitch';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import {
  fetchInvoiceSettings,
  removeInvoiceLogo,
  saveInvoiceLogo,
  updateInvoiceSettings,
} from '../api/sales';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import { resizeImage } from '../components/sales/image-upload.js';

/**
 * How this shop's invoices are printed (§5.8).
 *
 * Two templates — an A4 sheet and an 80mm receipt — over one renderer, so
 * everything here changes the preview, the print, the JPG and the shared copy
 * together.
 *
 * **Business Pad mode** is the setting a shop with its own printed pad needs:
 * the header block is suppressed and the content starts far enough down the
 * page to clear what is already on the paper.
 */
const session = useSession();

const settings = ref<InvoiceSettings | null>(null);
const saving = ref(false);
const saved = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const TEMPLATES = [
  { value: 'A4', label: 'A4 sheet' },
  { value: 'THERMAL_80', label: '80mm receipt' },
];
const THERMAL = [
  { value: '80mm', label: '80mm' },
  { value: '58mm', label: '58mm' },
];

const LANGUAGES = [
  { value: 'EN', label: 'English' },
  { value: 'BN', label: 'বাংলা' },
];

/** Only the boolean settings — the ones a switch can actually represent. */
type BooleanSetting = {
  [K in keyof InvoiceSettings]: InvoiceSettings[K] extends boolean ? K : never;
}[keyof InvoiceSettings];

const TOGGLES: readonly { key: BooleanSetting; label: string; detail: string }[] = [
  { key: 'showLogo', label: 'Logo', detail: 'Print the shop’s logo at the top.' },
  { key: 'showBusinessBlock', label: 'Business details', detail: 'Name, address and phone.' },
  { key: 'showCustomerBlock', label: 'Customer details', detail: 'Who the invoice is for.' },
  { key: 'showSku', label: 'Product code', detail: 'Show the SKU beside each item.' },
  { key: 'showBarcode', label: 'Barcode', detail: 'Show the barcode beside each item.' },
  { key: 'showDiscount', label: 'Discount', detail: 'Show what was knocked off.' },
  { key: 'showPaymentBreakdown', label: 'Payment breakdown', detail: 'Cash, bank and bKash, each with its amount.' },
  { key: 'showDue', label: 'Due', detail: 'Show what is still owed.' },
  { key: 'showAmountInWords', label: 'Amount in words', detail: 'The total written out.' },
];

/** What the logo box shows: the picked file, or what the server already holds. */
const pickedLogo = ref<string | null>(null);
const logoUrl = computed(() =>
  pickedLogo.value ?? (settings.value?.hasLogo === true ? `/api/v1/sales/invoice-logo?v=${String(logoVersion.value)}` : null),
);
const logoVersion = ref(0);

function addPhone(): void {
  settings.value?.contactPhones.push({ label: '', number: '' });
}

function removePhone(index: number): void {
  settings.value?.contactPhones.splice(index, 1);
}

function addMfs(): void {
  settings.value?.mfsNumbers.push({ label: '', number: '' });
}

function removeMfs(index: number): void {
  settings.value?.mfsNumbers.splice(index, 1);
}

function addTerm(): void {
  settings.value?.terms.push('');
}

function removeTerm(index: number): void {
  settings.value?.terms.splice(index, 1);
}

/**
 * The picked file is resized in the browser and saved on the spot.
 *
 * Saved immediately rather than with the rest of the form because a picture is
 * not a field a shopkeeper edits and reverts — they choose it and expect to see
 * it. The 400px edge is generous for a printed header and small enough that a
 * page of invoices carries it without thinking.
 */
async function onLogoPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  const token = session.accessToken.value;
  if (file === undefined || token === null) return;
  failure.value = null;
  try {
    const resized = await resizeImage(file, 800);
    pickedLogo.value = resized.previewUrl;
    settings.value = await saveInvoiceLogo(token, {
      mime: resized.mime,
      dataBase64: resized.dataBase64,
    });
    logoVersion.value += 1;
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not save that logo' };
  } finally {
    input.value = '';
  }
}

async function dropLogo(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    settings.value = await removeInvoiceLogo(token);
    pickedLogo.value = null;
    logoVersion.value += 1;
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not remove the logo' };
  }
}

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    settings.value = await fetchInvoiceSettings(token);
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not load invoice settings' };
  }
}

async function save(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || settings.value === null) return;
  saving.value = true;
  saved.value = false;
  failure.value = null;
  try {
    settings.value = await updateInvoiceSettings(token, settings.value);
    saved.value = true;
  } catch (cause) {
    failure.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'Could not save invoice settings' };
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <AppShell title="Invoice Design" help-bn="ইনভয়েসের ডিজাইন">
    <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

    <div v-if="settings" class="design">
      <header class="design__head">
        <h1>Invoice design</h1>
        <Button label="Save" :loading="saving" @click="save" />
      </header>
      <p v-if="saved" class="design__saved">Saved. Every invoice printed from now on uses this.</p>

      <AppCard>
        <h2 class="design__section">Shop Identity <small>দোকানের নাম ও ঠিকানা</small></h2>
        <label class="field">
          <span>Shop name on the invoice <small>দোকানের নাম</small></span>
          <InputText v-model="settings.businessName" placeholder="From the business profile" />
        </label>
        <div class="design__row">
          <label class="field">
            <span>Proprietor line <small>স্বত্বাধিকারী</small></span>
            <InputText
              v-model="settings.proprietorName"
              placeholder="প্রোঃ মহিউদ্দিন আহামেদ . ০১৭২৬-২২৪৪১১"
            />
            <small class="design__toggle-detail">
              Printed inside the black pill exactly as written — add the number if you want it there.
            </small>
          </label>
          <label class="field">
            <span>What this document is called <small>চালান / ক্যাশ মেমো</small></span>
            <InputText v-model="settings.invoiceTitle" placeholder="Invoice" />
          </label>
        </div>
        <label class="field">
          <span>Line under the proprietor’s name</span>
          <Textarea v-model="settings.proprietorNote" rows="2" auto-resize />
        </label>
        <label class="field">
          <span>What the shop sells <small>ব্যবসার বিবরণ</small></span>
          <Textarea v-model="settings.businessDescription" rows="2" auto-resize />
          <small class="design__toggle-detail">
            Press Enter where you want the line to break on the invoice.
          </small>
        </label>
        <label class="field">
          <span>Shop address <small>ঠিকানা</small></span>
          <Textarea v-model="settings.businessAddress" rows="2" auto-resize />
          <small class="design__toggle-detail">
            One line here is one line on the invoice — press Enter where you want the break.
          </small>
        </label>
        <p class="design__toggle-detail">
          Phone numbers <small>ফোন নম্বর</small> — printed in this order.
        </p>
        <div v-for="(phone, index) in settings.contactPhones" :key="index" class="design__listrow">
          <InputText v-model="phone.label" placeholder="মহিউদ্দিন" />
          <InputText v-model="phone.number" placeholder="01726-224411" />
          <Button icon="pi pi-times" severity="danger" text @click="removePhone(index)" />
        </div>
        <Button label="+ Add phone number" text @click="addPhone" />
      </AppCard>

      <div class="design__pair">
        <AppCard>
          <h2 class="design__section">Logo <small>দোকানের লোগো</small></h2>
          <div class="design__logo">
            <div class="design__logo-box">
              <img v-if="logoUrl" :src="logoUrl" alt="Shop logo" />
              <span v-else>No logo</span>
            </div>
            <div class="design__logo-actions">
              <input type="file" accept="image/*" @change="onLogoPicked" />
              <Button
                v-if="settings.hasLogo"
                label="Remove logo"
                severity="danger"
                text
                @click="dropLogo"
              />
              <p class="design__toggle-detail">
                PNG, JPEG or WebP. It is resized to 800px before it is saved, and prints at one standard size.
              </p>
            </div>
          </div>
        </AppCard>

        <AppCard>
          <h2 class="design__section">Opening line <small>বিসমিল্লাহ</small></h2>
          <div class="design__toggle">
            <ToggleSwitch v-model="settings.showHeaderText" />
            <p class="design__toggle-label">Print an opening line on every invoice</p>
          </div>
          <label class="field">
            <span>The words</span>
            <Textarea
              v-model="settings.headerText"
              rows="2"
              auto-resize
              placeholder="بِسْمِ اللهِ الرَّحْمٰنِ الرَّحِيْمِ"
            />
          </label>
        </AppCard>
      </div>

      <div class="design__pair">
        <AppCard>
          <h2 class="design__section">Mobile money <small>বিকাশ, নগদ নম্বর</small></h2>
          <p class="design__toggle-detail">Printed so a customer knows where to send money.</p>
          <div v-for="(entry, index) in settings.mfsNumbers" :key="index" class="design__listrow">
            <InputText v-model="entry.label" placeholder="বিকাশ" />
            <InputText v-model="entry.number" placeholder="01XXXXXXXXX" />
            <Button icon="pi pi-times" severity="danger" text @click="removeMfs(index)" />
          </div>
          <Button label="+ Add number" text @click="addMfs" />
        </AppCard>

        <AppCard>
          <h2 class="design__section">Terms &amp; conditions <small>শর্তাবলী</small></h2>
          <div v-for="(term, index) in settings.terms" :key="index" class="design__listrow">
            <InputText v-model="settings.terms[index]" placeholder="বিক্রিত মাল গুনে বুঝে নিন।" />
            <Button icon="pi pi-times" severity="danger" text @click="removeTerm(index)" />
          </div>
          <Button label="+ Add term" text @click="addTerm" />
        </AppCard>
      </div>

      <AppCard>
        <h2 class="design__section">Footer &amp; payment terms <small>নিচের লেখা ও শর্ত</small></h2>
        <label class="field">
          <span>Footer text</span>
          <Textarea v-model="settings.footerText" rows="2" auto-resize />
        </label>
        <div class="design__row">
          <label class="field">
            <span>Payment terms (days)</span>
            <InputNumber v-model="settings.paymentTermsDays" :min="0" :max="365" />
          </label>
          <label class="field">
            <span>Payment terms label</span>
            <InputText v-model="settings.paymentTermsLabel" />
          </label>
        </div>
      </AppCard>

      <AppCard>
        <h2 class="design__section">Paper <small>কাগজের মাপ</small></h2>
        <div class="design__row">
          <label class="field">
            <span>Default language <small>ভাষা</small></span>
            <Select
              v-model="settings.language"
              :options="LANGUAGES"
              option-label="label"
              option-value="value"
            />
          </label>
          <label class="field">
            <span>Default template</span>
            <Select
              v-model="settings.defaultTemplate"
              :options="TEMPLATES"
              option-label="label"
              option-value="value"
            />
          </label>
        </div>
        <div class="design__row">
          <label class="field">
            <span>Thermal paper size</span>
            <Select
              v-model="settings.thermalPaper"
              :options="THERMAL"
              option-label="label"
              option-value="value"
            />
          </label>
          <p class="design__toggle-detail">
            Both are only the defaults — either can be switched for one copy when the invoice is
            printed.
          </p>
        </div>
        <div class="design__toggle">
          <ToggleSwitch v-model="settings.showSignatureLines" />
          <p class="design__toggle-label">Leave signature lines at the bottom</p>
        </div>
      </AppCard>

      <AppCard>
        <h2 class="design__section">What is printed</h2>
        <div v-for="toggle in TOGGLES" :key="toggle.key" class="design__toggle">
          <ToggleSwitch v-model="settings[toggle.key]" />
          <div>
            <p class="design__toggle-label">{{ toggle.label }}</p>
            <p class="design__toggle-detail">{{ toggle.detail }}</p>
          </div>
        </div>
      </AppCard>

      <AppCard>
        <h2 class="design__section">Business Pad</h2>
        <p class="design__toggle-detail">
          For a shop printing on its own letterhead pad: the header block is left off and the invoice
          starts below what is already on the paper.
        </p>
        <div class="design__toggle">
          <ToggleSwitch v-model="settings.businessPadEnabled" />
          <p class="design__toggle-label">Printing on my own pad</p>
        </div>
        <div class="design__row">
          <label class="field">
            <span>Start content this far down (mm)</span>
            <InputNumber v-model="settings.businessPadTopMm" :min="0" :max="150" />
          </label>
          <label class="field">
            <span>Page margin (mm)</span>
            <InputNumber v-model="settings.pageMarginMm" :min="0" :max="50" />
          </label>
        </div>
      </AppCard>

      <AppCard>
        <h2 class="design__section">Words at the bottom</h2>
        <label class="field">
          <span>Terms &amp; conditions</span>
          <Textarea v-model="settings.termsText" rows="2" auto-resize />
        </label>
        <label class="field">
          <span>Footer</span>
          <InputText v-model="settings.footerText" />
        </label>
      </AppCard>
    </div>
  </AppShell>
</template>

<style scoped>
.design {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  max-width: 46rem;
}

.design__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.design__head h1 {
  margin: 0;
  font-size: 1.3rem;
}

.design__saved {
  margin: 0;
  color: #15803d;
  font-size: 0.85rem;
}

.design__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
}

.design__section {
  font-size: 0.95rem;
  margin: 0 0 0.5rem;
}

.design__toggle {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.3rem 0;
}

.design__toggle-label {
  margin: 0;
  font-weight: 600;
  font-size: 0.85rem;
}

/*
 * The box shows the logo at the size it will print (the invoice mark is 110px
 * tall inside a 60mm-wide box), so what is picked here is what comes out.
 */
.design__logo {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}

.design__logo-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 220px;
  height: 130px;
  padding: 8px;
  border: 1px dashed var(--sher-line-strong);
  border-radius: var(--sher-radius-sm);
  background: #ffffff;
}

.design__logo-box img {
  max-height: 110px;
  max-width: 100%;
  object-fit: contain;
}

.design__logo-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.design__toggle-detail {
  margin: 0;
  font-size: 0.78rem;
  opacity: 0.7;
}
</style>
