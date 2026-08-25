<script setup lang="ts">
import type {
  CatalogResponse,
  DayStatusResponse,
  MoneyAccountResponse,
  PartyResponse,
  ProductResponse,
  PurchaseLineRequest,
} from '@sher/core-contracts';
import { SystemClock, Ulid } from '@sher/shared-utils';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputNumber from 'primevue/inputnumber';
import InputText from 'primevue/inputtext';
import Textarea from 'primevue/textarea';
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { EMPTY_CATALOG, fetchCatalog } from '../api/catalog';
import { fetchAccounts, fetchDayStatus } from '../api/money';
import { fetchParties } from '../api/parties';
import { fetchProducts } from '../api/products';
import { createPurchase } from '../api/purchasing';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import DateOnlyPicker from '../components/DateOnlyPicker.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import HelpTip from '../components/HelpTip.vue';
import ProductForm from '../components/ProductForm.vue';
import ComboField from '../components/fields/ComboField.vue';
import AppShell from '../components/shell/AppShell.vue';
import { MONEY_BN, taka } from '../components/money/money-text';
import StartDayDialog from '../components/money/StartDayDialog.vue';
import PartyFormPage from './PartyFormPage.vue';

/**
 * New Purchase (§5.9) — and the reference screen for the **Flow Rule**
 * (UI-76 … UI-80, owner decision 2026-08-25).
 *
 * The screen is one downward flow, and the next action is always the thing
 * below the last one:
 *
 *   Supplier → Product → Discount / Extra cost → Payment → Complete Purchase
 *
 * There are no section headings dividing it up. A heading tells a reader what a
 * block is called; a shopkeeper filling in a bill needs to know what to do
 * next, and an empty field below a filled one already says it. Every selectable
 * field — supplier, product, category, payment method — is the same
 * `ComboField`: type to search, chevron to browse, `+` inside the control to
 * add what is not there yet.
 *
 * A **page**, not a dialog: a bill has a growing list of lines plus totals and
 * a payment, which is more than a modal can hold on a phone.
 */
const session = useSession();
const router = useRouter();
const clock = new SystemClock();

interface Line {
  readonly productId: string;
  readonly productName: string;
  readonly productCode: string;
  readonly unitName: string;
  readonly tracksExpiry: boolean;
  qty: number;
  /** Taka, as typed. Converted to poisha only when the bill is sent. */
  rate: number;
  expiryDate: string;
  showDetail: boolean;
}

const today = clock.businessDate(Intl.DateTimeFormat().resolvedOptions().timeZone);

const supplierId = ref('');
const billRef = ref('');
const businessDate = ref(today);
const dueDate = ref('');
const notes = ref('');
const lines = ref<Line[]>([]);
const categoryId = ref('');
const discount = ref(0);
const extraCost = ref(0);
const paid = ref(0);
const paidAccountId = ref('');

const suppliers = ref<readonly PartyResponse[]>([]);
const accounts = ref<readonly MoneyAccountResponse[]>([]);
const catalog = ref<CatalogResponse>(EMPTY_CATALOG);
const saving = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

/* The cash day, only ever fetched when a refusal says the drawer is shut. */
const dayStatus = ref<DayStatusResponse | null>(null);
const startingDay = ref(false);
const dayBlocked = ref(false);

const addingSupplier = ref(false);
const addingProduct = ref(false);
const newProductName = ref('');

/** One key per bill, reused on retry, so two taps post one purchase (UI-34). */
const operationId = ref(Ulid.generate(clock));

const canCreate = computed(() => session.can('purchase.bill.create'));
const canAddSupplier = computed(() => session.can('party.supplier.create'));
const canAddProduct = computed(() => session.can('catalog.product.create'));

const supplierOptions = computed(() =>
  suppliers.value.map((party) => ({
    id: party.id,
    label: party.name,
    sublabel: party.phone ?? undefined,
  })),
);

const categoryOptions = computed(() => [
  { id: '', label: 'All Categories' },
  ...catalog.value.categories.map((category) => ({ id: category.id, label: category.name })),
]);

const ACCOUNT_ICONS: Record<string, string> = {
  CASH: 'pi-money-bill',
  BANK: 'pi-building-columns',
  MFS: 'pi-mobile',
};

const accountOptions = computed(() =>
  accounts.value.map((account) => ({
    id: account.id,
    label: account.name,
    sublabel: account.isDrawer ? 'Drawer · নগদ' : undefined,
    icon: ACCOUNT_ICONS[account.type] ?? 'pi-wallet',
  })),
);

const accountCode = computed(() => {
  const account = accounts.value.find((row) => row.id === paidAccountId.value);
  if (account === undefined) return null;
  return account.type === 'CASH' ? `CASH:${account.id}` : `BANK:${account.id}`;
});

/* Every figure below is recomputed here only so the shopkeeper can see the bill
 * add up as they type. The server works all of it out again from the lines
 * (DR13.12) — nothing computed on this screen is ever posted. */
function minor(taka_: number): number {
  return Math.round(taka_ * 100);
}

function lineTotalMinor(line: Line): number {
  return Math.round(line.qty * minor(line.rate));
}

const subtotalMinor = computed(() =>
  lines.value.reduce((sum, line) => sum + lineTotalMinor(line), 0),
);
const grandTotalMinor = computed(
  () => subtotalMinor.value - minor(discount.value) + minor(extraCost.value),
);
const dueMinor = computed(() => Math.max(grandTotalMinor.value - minor(paid.value), 0));

const readyToSave = computed(
  () =>
    canCreate.value &&
    supplierId.value !== '' &&
    lines.value.length > 0 &&
    lines.value.every((line) => line.qty > 0) &&
    grandTotalMinor.value > 0 &&
    minor(paid.value) <= grandTotalMinor.value &&
    (minor(paid.value) === 0 || accountCode.value !== null),
);

async function loadSetup(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    const [supplierPage, accountPage, catalogResponse] = await Promise.all([
      fetchParties(token, { role: 'SUPPLIER', status: 'ACTIVE', limit: 200 }),
      fetchAccounts(token),
      fetchCatalog(token),
    ]);
    suppliers.value = supplierPage.data;
    accounts.value = accountPage.accounts.filter((account) => account.status === 'ACTIVE');
    catalog.value = catalogResponse;
    const drawer = accounts.value.find((account) => account.isDrawer);
    if (drawer !== undefined && paidAccountId.value === '') paidAccountId.value = drawer.id;
  } catch (cause) {
    failure.value = describe(cause, 'Could not load suppliers and accounts');
  }
}

/**
 * The product list the server filters, narrowed by the category beside it.
 *
 * Remote rather than a preloaded list: a shop with four thousand products
 * cannot hold its catalog in a dropdown, and the search is the same one the
 * Products screen uses.
 */
async function searchProducts(term: string): Promise<readonly {
  id: string;
  label: string;
  sublabel?: string;
}[]> {
  const token = session.accessToken.value;
  if (token === null) return [];
  const page = await fetchProducts(token, {
    ...(term === '' ? {} : { search: term }),
    ...(categoryId.value === '' ? {} : { categoryId: categoryId.value }),
    status: 'ACTIVE',
    limit: 10,
  });
  productCache.value = page.data;
  return page.data.map((product) => ({
    id: product.id,
    label: product.name,
    sublabel: [product.sku ?? product.barcode, product.baseUnitName]
      .filter((part) => part != null && part !== '')
      .join(' · '),
  }));
}

/** The last search's products, so a chosen id becomes a full line. */
const productCache = ref<readonly ProductResponse[]>([]);
const productPick = ref('');

function onProductPicked(option: { id: string }): void {
  const product = productCache.value.find((row) => row.id === option.id);
  if (product !== undefined) addLine(product);
  productPick.value = '';
}

function addLine(product: ProductResponse): void {
  lines.value.push({
    productId: product.id,
    productName: product.name,
    productCode: product.sku ?? product.barcode ?? '',
    unitName: product.baseUnitName,
    tracksExpiry: product.tracksExpiry,
    qty: 1,
    // The last thing this cost is the best first guess; the shopkeeper
    // overwrites it whenever the supplier changed their rate.
    rate: (product.purchasePriceMinor ?? 0) / 100,
    expiryDate: '',
    showDetail: false,
  });
}

function removeLine(index: number): void {
  lines.value.splice(index, 1);
}

async function focusProductField(): Promise<void> {
  await nextTick();
  document.getElementById('purchase-product')?.focus();
}

function openAddProduct(typed: string): void {
  newProductName.value = typed;
  addingProduct.value = true;
}

function onProductCreated(product: ProductResponse): void {
  addingProduct.value = false;
  addLine(product);
  void focusProductField();
}

async function onSupplierCreated(party: PartyResponse): Promise<void> {
  addingSupplier.value = false;
  await loadSetup();
  supplierId.value = party.id;
  await focusProductField();
}

async function offerStartDay(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    dayStatus.value = await fetchDayStatus(token);
    startingDay.value = true;
  } catch (cause) {
    failure.value = describe(cause, 'Could not open the day');
  }
}

async function onDayStarted(): Promise<void> {
  startingDay.value = false;
  dayBlocked.value = false;
  // The bill is still exactly as it was typed — nothing here is cleared, and
  // the same save is simply tried again.
  await save();
}

async function save(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !readyToSave.value) return;

  saving.value = true;
  failure.value = null;

  try {
    const purchase = await createPurchase(
      token,
      {
        supplierPartyId: supplierId.value,
        supplierBillRef: billRef.value.trim() === '' ? null : billRef.value.trim(),
        businessDate: businessDate.value,
        dueDate: dueDate.value === '' ? null : dueDate.value,
        lines: lines.value.map(
          (line): PurchaseLineRequest => ({
            productId: line.productId,
            qty: Math.round(line.qty * 1000),
            unitPriceMinor: minor(line.rate),
            expiryDate: line.expiryDate === '' ? null : line.expiryDate,
          }),
        ),
        discountMinor: minor(discount.value),
        extraCostMinor: minor(extraCost.value),
        paidMinor: minor(paid.value),
        paidAccountCode: minor(paid.value) === 0 ? null : accountCode.value,
        notes: notes.value.trim() === '' ? null : notes.value.trim(),
      },
      operationId.value,
    );
    await router.push({ path: `/purchases/${purchase.id}`, query: { saved: '1' } });
  } catch (cause) {
    // The one refusal that is not a dead end: the drawer is shut, so the screen
    // offers to open the day right here and keeps the typed bill (owner
    // decision 2026-08-24).
    dayBlocked.value =
      cause instanceof ApiError && cause.details['reason'] === 'CASH_DAY_NOT_STARTED';
    failure.value = describe(cause, 'Could not save this purchase');
  } finally {
    saving.value = false;
  }
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNKNOWN', message: fallback };
}

onMounted(loadSetup);
</script>

<template>
  <AppShell title="New Purchase" help-bn="সরবরাহকারীর কাছ থেকে কেনা মাল এখানে লিখুন">
    <AppCard v-if="!canCreate">
      <p class="notice is-bad">You do not have permission to record a purchase.</p>
    </AppCard>

    <template v-else>
      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <!--
        The drawer is shut. Nothing is lost: the bill stays on screen and the
        day can be started without leaving it.
      -->
      <AppCard v-if="dayBlocked">
        <div class="callout is-warn">
          <i class="pi pi-exclamation-triangle callout-icon" aria-hidden="true" />
          <div class="callout-body">
            <span class="callout-title">{{ MONEY_BN.dayNotStarted }}</span>
            <p>Cash cannot leave the drawer until the day is started. Your bill is still here.</p>
            <div class="day-block-action">
              <Button icon="pi pi-play" :label="MONEY_BN.startDay" @click="offerStartDay" />
            </div>
          </div>
        </div>
      </AppCard>

      <!-- 1 ─ who it is from ------------------------------------------------ -->
      <AppCard>
        <div class="row row-4">
          <ComboField
            v-model="supplierId"
            field-id="purchase-supplier"
            label="Supplier"
            label-bn="সরবরাহকারী"
            placeholder="Search supplier by name / phone"
            leading-icon="pi-search"
            required
            :options="supplierOptions"
            :on-add="canAddSupplier ? () => (addingSupplier = true) : undefined"
            @selected="focusProductField"
          />

          <div class="field">
            <label for="purchase-date">
              Purchase Date <span class="req">*</span>
              <span class="label-bn">ক্রয়ের তারিখ</span>
            </label>
            <DateOnlyPicker v-model="businessDate" input-id="purchase-date" />
          </div>

          <div class="field">
            <label for="purchase-ref">
              Supplier Bill No <span class="label-bn">সরবরাহকারীর বিল নং</span>
            </label>
            <InputText id="purchase-ref" v-model="billRef" placeholder="Optional" maxlength="64" fluid />
          </div>

          <div class="field">
            <label for="purchase-due">
              Due Date <span class="label-bn">টাকা দেওয়ার তারিখ</span>
              <HelpTip
                label="Due Date"
                text="Only if the supplier named a day. Leave it blank otherwise."
                text-bn="সরবরাহকারী দিন বলে থাকলে লিখুন, না হলে খালি রাখুন"
              />
            </label>
            <DateOnlyPicker v-model="dueDate" input-id="purchase-due" placeholder="Optional" />
          </div>
        </div>
      </AppCard>

      <!-- 2 ─ what came in -------------------------------------------------- -->
      <AppCard>
        <div class="row row-product">
          <ComboField
            v-model="productPick"
            field-id="purchase-product"
            label="Add Product"
            label-bn="পণ্য যোগ করুন"
            placeholder="Search any product by name / code"
            leading-icon="pi-search"
            clear-on-select
            :search="searchProducts"
            :on-add="canAddProduct ? openAddProduct : undefined"
            @selected="onProductPicked"
          />

          <!-- A filter, not a list to maintain: no `+`, no cog (owner, 2026-08-25). -->
          <ComboField
            v-model="categoryId"
            field-id="purchase-category"
            :options="categoryOptions"
            placeholder="All Categories"
            label-bn="সব ক্যাটাগরি"
          />
        </div>

        <div v-if="lines.length > 0" class="lines-scroll">
        <table class="lines">
          <thead>
            <tr>
              <th class="idx">#</th>
              <th>Product <span class="label-bn">পণ্য</span></th>
              <th class="num">Qty <span class="label-bn">পরিমাণ</span></th>
              <th class="mid">Unit <span class="label-bn">একক</span></th>
              <th class="num">Unit Price <span class="label-bn">একক দাম</span></th>
              <th class="num">Line Total <span class="label-bn">লাইন মোট</span></th>
              <th class="mid">Action</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="(line, index) in lines" :key="`${line.productId}-${index}`">
              <tr>
                <td class="idx">{{ index + 1 }}</td>
                <td>
                  <div class="product-cell">
                    <span class="thumb" aria-hidden="true"><i class="pi pi-box" /></span>
                    <span>
                      <strong>{{ line.productName }}</strong>
                      <span v-if="line.productCode" class="muted">{{ line.productCode }}</span>
                    </span>
                  </div>
                </td>
                <td class="num">
                  <InputNumber
                    v-model="line.qty"
                    :min="0"
                    :max-fraction-digits="3"
                    :input-props="{ 'aria-label': `Quantity for ${line.productName}` }"
                    input-class="cell-input"
                    fluid
                  />
                </td>
                <td class="mid unit">{{ line.unitName }}</td>
                <td class="num">
                  <InputNumber
                    v-model="line.rate"
                    :min="0"
                    :min-fraction-digits="2"
                    :max-fraction-digits="2"
                    :input-props="{ 'aria-label': `Unit price for ${line.productName}` }"
                    input-class="cell-input"
                    fluid
                  />
                </td>
                <td class="num total">{{ taka(lineTotalMinor(line)) }}</td>
                <td class="mid">
                  <div class="line-actions">
                    <Button
                      v-if="line.tracksExpiry"
                      v-tooltip.top="'Expiry date — মেয়াদ'"
                      icon="pi pi-pencil"
                      outlined
                      size="small"
                      :aria-label="`Expiry date for ${line.productName}`"
                      @click="line.showDetail = !line.showDetail"
                    />
                    <Button
                      v-tooltip.top="'Remove'"
                      icon="pi pi-trash"
                      outlined
                      severity="danger"
                      size="small"
                      :aria-label="`Remove ${line.productName}`"
                      @click="removeLine(index)"
                    />
                  </div>
                </td>
              </tr>
              <!-- Only where the product tracks expiry; optional even then. -->
              <tr v-if="line.showDetail" class="detail-row">
                <td class="idx"></td>
                <td colspan="6">
                  <div class="field detail-field">
                    <label :for="`expiry-${index}`">
                      Expiry date <span class="label-bn">মেয়াদ শেষ হওয়ার তারিখ</span>
                    </label>
                    <DateOnlyPicker
                      v-model="line.expiryDate"
                      :input-id="`expiry-${index}`"
                      placeholder="Optional"
                    />
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        </div>

        <div class="after-lines">
          <div class="add-another">
            <Button
              icon="pi pi-plus"
              label="Add Another Product"
              outlined
              size="small"
              @click="focusProductField"
            />
            <span class="label-bn">আরেকটি পণ্য যোগ করুন</span>
          </div>

          <!-- 3 ─ what it comes to -->
          <div class="totals">
            <div class="total-row">
              <span>Subtotal <span class="label-bn">মোট টাকা</span></span>
              <span class="figure">{{ taka(subtotalMinor) }}</span>
            </div>
            <div class="total-row">
              <span>Discount <span class="label-bn">ডিসকাউন্ট</span></span>
              <InputNumber
                v-model="discount"
                :min="0"
                :min-fraction-digits="2"
                :max-fraction-digits="2"
                :input-props="{ 'aria-label': 'Discount' }"
                input-class="cell-input"
                class="total-input"
                fluid
              />
            </div>
            <div class="total-row">
              <span>
                Extra Cost <span class="label-bn">অতিরিক্ত খরচ (যেমন: ভাড়া)</span>
                <HelpTip
                  label="Extra Cost"
                  text="Transport, labour and anything else paid to get the goods here. It is added to what the stock cost."
                  text-bn="মাল আনতে যে খরচ হলো — এটা মালের দামের সাথে যোগ হবে"
                />
              </span>
              <InputNumber
                v-model="extraCost"
                :min="0"
                :min-fraction-digits="2"
                :max-fraction-digits="2"
                :input-props="{ 'aria-label': 'Extra cost' }"
                input-class="cell-input"
                class="total-input"
                fluid
              />
            </div>
            <div class="total-row is-grand">
              <span>Grand Total <span class="label-bn">সর্বমোট</span></span>
              <strong class="figure">{{ taka(grandTotalMinor) }}</strong>
            </div>
          </div>
        </div>
      </AppCard>

      <!-- 4 ─ what was paid ------------------------------------------------- -->
      <AppCard>
        <div class="row row-3">
          <div class="field">
            <label for="purchase-paid">
              Paid Now <span class="label-bn">এখন কত টাকা দিলেন</span>
            </label>
            <InputNumber
              v-model="paid"
              input-id="purchase-paid"
              :min="0"
              :min-fraction-digits="2"
              :max-fraction-digits="2"
              fluid
            />
          </div>

          <ComboField
            v-model="paidAccountId"
            field-id="purchase-account"
            label="Payment Method"
            label-bn="কীভাবে টাকা দিলেন"
            placeholder="Cash, bank or bKash"
            :required="minor(paid) > 0"
            :disabled="minor(paid) === 0"
            :options="accountOptions"
          />

          <div class="field">
            <label for="purchase-due-amount">
              Due to Supplier <span class="label-bn">বাকি থাকল</span>
            </label>
            <InputText
              id="purchase-due-amount"
              :model-value="taka(dueMinor)"
              readonly
              tabindex="-1"
              fluid
            />
          </div>
        </div>

        <div class="field notes-field">
          <label for="purchase-notes">Notes <span class="label-bn">নোট (ঐচ্ছিক)</span></label>
          <Textarea
            id="purchase-notes"
            v-model="notes"
            rows="3"
            maxlength="300"
            placeholder="Any additional notes..."
            fluid
          />
          <span class="counter">{{ notes.length }} / 300</span>
        </div>
      </AppCard>

      <!-- 5 ─ finish -->
      <div class="finish-bar">
        <span class="finish-total">
          <span class="label-bn">সর্বমোট:</span>
          <strong>{{ taka(grandTotalMinor) }}</strong>
        </span>
        <!--
          The icon lives in the slot, not in the `icon` prop: PrimeVue marks a
          button `p-button-icon-only` when it has an icon and no `label`, and the
          theme then pins it to a fixed ~3rem width with no padding — which
          clipped this label to "…rchase" however the bar around it was laid out
          (owner-reported, 2026-08-25).
        -->
        <Button
          class="finish-button"
          :disabled="!readyToSave"
          :loading="saving"
          size="large"
          @click="save"
        >
          <span class="finish-label">
            <i class="pi pi-shopping-cart" aria-hidden="true" />
            Complete Purchase <span class="label-bn on-primary">ক্রয় সম্পন্ন করুন</span>
          </span>
        </Button>
      </div>
    </template>

    <!-- A supplier who is not on the list yet, without losing the bill (UI-50). -->
    <Dialog
      v-model:visible="addingSupplier"
      modal
      header="Add supplier — নতুন সরবরাহকারী"
      :style="{ width: 'min(46rem, 96vw)' }"
    >
      <PartyFormPage
        embedded
        embedded-role="SUPPLIER"
        @saved="onSupplierCreated"
        @close="addingSupplier = false"
      />
    </Dialog>

    <!-- The same product form the catalog uses, so there is one write path. -->
    <Dialog
      v-model:visible="addingProduct"
      modal
      header="Add product — নতুন পণ্য"
      :style="{ width: 'min(52rem, 96vw)' }"
    >
      <ProductForm
        :key="newProductName"
        :product-id="null"
        @saved="onProductCreated"
        @close="addingProduct = false"
      />
    </Dialog>

    <StartDayDialog
      v-if="startingDay && dayStatus !== null"
      :status="dayStatus"
      @started="onDayStarted"
      @close="startingDay = false"
    />
  </AppShell>
</template>

<style scoped>
.row {
  display: grid;
  gap: var(--sher-space-3, 12px);
  align-items: end;
}

.row-4 {
  grid-template-columns: 1.4fr 1fr 1fr 1fr;
}

.row-3 {
  grid-template-columns: 1fr 1fr 1fr;
}

.row-product {
  grid-template-columns: 2fr 1fr;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field label {
  font-size: var(--sher-text-sm, 13px);
  font-weight: 600;
}

.req {
  margin-left: 2px;
  color: var(--sher-danger, #dc2626);
}

.label-bn {
  margin-left: 6px;
  font-size: 11px;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.label-bn.on-primary {
  color: inherit;
  opacity: 0.85;
}

/* ---------------------------------------------------------------- lines */
.lines {
  width: 100%;
  margin-top: var(--sher-space-4, 16px);
  border-collapse: collapse;
}

.lines thead th {
  padding: 10px 8px;
  background: var(--sher-surface-2, #f6f8fb);
  border-bottom: 1px solid var(--sher-border, #e3e8ee);
  font-size: var(--sher-text-sm, 13px);
  font-weight: 600;
  text-align: left;
}

.lines tbody td {
  padding: 8px;
  border-bottom: 1px solid var(--sher-border, #e3e8ee);
  vertical-align: middle;
}

.lines .idx {
  width: 3rem;
  text-align: center;
  color: var(--sher-text-muted);
}

.lines .mid {
  text-align: center;
}

.lines .num {
  text-align: right;
}

.lines th.num,
.lines th.mid {
  text-align: center;
}

.product-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}

.thumb {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: var(--sher-radius, 8px);
  background: var(--sher-surface-2, #f1f4f9);
  color: var(--sher-text-muted);
}

.product-cell .muted {
  display: block;
  font-size: 11px;
  color: var(--sher-text-muted);
}

.unit {
  color: var(--sher-text-muted);
}

.total {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

:deep(.cell-input) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.line-actions {
  display: flex;
  justify-content: center;
  gap: 6px;
}

.detail-row td {
  background: var(--sher-surface-2, #f8fafc);
}

.detail-field {
  max-width: 18rem;
}

/* ------------------------------------------------------ totals + add more */
.after-lines {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sher-space-4, 16px);
  margin-top: var(--sher-space-3, 12px);
  flex-wrap: wrap;
}

.add-another {
  display: flex;
  align-items: center;
  gap: 8px;
}

.totals {
  flex: 1 1 22rem;
  min-width: 0;
  max-width: 34rem;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: var(--sher-space-4, 16px);
  border-radius: var(--sher-radius, 8px);
  background: var(--sher-surface-2, #f8fafc);
}

.total-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: var(--sher-text-sm, 13px);
}

.total-row .figure {
  font-variant-numeric: tabular-nums;
}

.total-input {
  flex: 0 0 10rem;
  width: 10rem;
  max-width: 50%;
}

.total-row.is-grand {
  padding-top: 10px;
  border-top: 1px solid var(--sher-border, #e3e8ee);
  font-size: 17px;
  font-weight: 600;
}

.total-row.is-grand strong {
  font-size: 22px;
  color: var(--sher-primary, #2563eb);
}

/* --------------------------------------------------------------- payment */
.notes-field {
  position: relative;
  margin-top: var(--sher-space-3, 12px);
}

.counter {
  align-self: flex-end;
  font-size: 11px;
  color: var(--sher-text-muted);
}

/* ---------------------------------------------------------------- finish */
.finish-bar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--sher-space-3, 12px) var(--sher-space-4, 16px);
  padding: 10px 0;
  background: var(--sher-bg, #fff);
}

/*
 * `.p-button` sets `overflow: hidden`, which gives a flex item an automatic
 * minimum size of zero — so the button shrank below its own label and clipped
 * it to "…rchase" instead of pushing back. It holds its content width now.
 */
.finish-bar :deep(.finish-button) {
  flex: 0 0 auto;
  max-width: 100%;
  white-space: nowrap;
}

.finish-total {
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: 15px;
}

.finish-total strong {
  font-size: 20px;
  color: var(--sher-primary, #2563eb);
  font-variant-numeric: tabular-nums;
}

.finish-label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}

/* The table's own scroller, so the page itself never scrolls sideways. */
.lines-scroll {
  margin-top: var(--sher-space-4, 16px);
  overflow-x: auto;
}

.lines-scroll .lines {
  margin-top: 0;
  min-width: 44rem;
}

.day-block-action {
  margin-top: 8px;
}

@media (max-width: 900px) {
  .row-4,
  .row-3,
  .row-product {
    grid-template-columns: 1fr;
  }

  .totals {
    max-width: none;
  }
}
</style>
