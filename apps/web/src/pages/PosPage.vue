<script setup lang="ts">
import type {
  CatalogResponse,
  SaleDraftResponse,
  CustomerStandingResponse,
  DayStatusResponse,
  MoneyAccountResponse,
  PartyResponse,
  PosProduct,
  SaleLineRequest,
  SalePaymentRequest,
  SaleResponse,
} from '@sher/core-contracts';
import { searchProducts, searchTokens } from '@sher/core-domain';
import { amountInWords, SystemClock, Ulid } from '@sher/shared-utils';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { ApiError } from '../api/client';
import { EMPTY_CATALOG, fetchCatalog } from '../api/catalog';
import { fetchAccounts, fetchDayStatus } from '../api/money';
import { fetchParties } from '../api/parties';
import {
  cancelSale,
  createSale,
  deleteSaleDraft,
  fetchCustomerStanding,
  fetchPosProducts,
  fetchSale,
  fetchSaleDrafts,
  saveSaleDraft,
} from '../api/sales';
import { useSession } from '../auth/session';
import Dialog from 'primevue/dialog';

import ConfirmDialog from '../components/ConfirmDialog.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AmountInput from '../components/fields/AmountInput.vue';
import ProductForm from '../components/ProductForm.vue';
import PartyFormPage from './PartyFormPage.vue';
import AppShell from '../components/shell/AppShell.vue';
import { MONEY_BN, taka } from '../components/money/money-text';
import StartDayDialog from '../components/money/StartDayDialog.vue';
import InvoicePreviewDialog from '../components/sales/InvoicePreviewDialog.vue';
import { cartTotals, type CartLine } from '../components/sales/cart';

/**
 * The counter (§5.7, owner mockup `Light UI (3).png`, decisions 2026-08-25).
 *
 * One scan/search bar on top, the product grid on the left, the cart on the
 * right — the layout the owner drew, serving both a barcode scanner and a
 * touch screen without two workflows.
 *
 * **Every figure on this screen is computed here, on every keystroke**, and
 * every one of them is computed by `saleTotals` from `@sher/core-domain` — the
 * same function the posting service runs (see `components/sales/cart.ts`). The
 * owner's binding rule is that an amount never waits for a save or a reload;
 * the honest way to keep that promise without a round trip is to run the
 * server's arithmetic in the browser, not a second version of it. Nothing shown
 * here is ever posted: the server recomputes everything from the lines
 * (DR13.12).
 */
const session = useSession();
const router = useRouter();
const route = useRoute();
const clock = new SystemClock();
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const today = clock.businessDate(timezone);

const search = ref('');
const view = ref<'GRID' | 'LIST'>('GRID');
const categoryId = ref('');
const brandId = ref('');
const products = ref<readonly PosProduct[]>([]);
/**
 * What the grid shows: the last server page, narrowed and ranked **in the
 * browser** by what has been typed since.
 *
 * The request is debounced — one per pause, not one per character — but the
 * grid must not be. Between the keystroke and the response the counter still
 * sees the list shrink, ranked by the same domain rule the server applies, so
 * the two never disagree about order and nothing appears to jump when the
 * response lands.
 */
const shown = computed(() => searchProducts(search.value, products.value));
/** Which tile the arrow keys are on; Enter adds it. */
const highlighted = ref(0);
const catalog = ref<CatalogResponse>(EMPTY_CATALOG);
const loadingProducts = ref(false);

const lines = ref<CartLine[]>([]);
const discount = ref(0);
const notes = ref('');
const dueDate = ref('');

const customerId = ref('');
const customerName = ref('');
const customerPhone = ref('');
const guardianName = ref('');
const address = ref('');
const showMoreCustomer = ref(false);
const standing = ref<CustomerStandingResponse | null>(null);
const customers = ref<readonly PartyResponse[]>([]);
/* Vendors are a different role entirely (D-04): consignment goods belong to a
 * vendor, and offering the customer list here would put someone's own customer
 * down as the owner of the stock. */
const vendors = ref<readonly PartyResponse[]>([]);
const addingVendor = ref(false);
const vendorLineIndex = ref<number | null>(null);

const accounts = ref<readonly MoneyAccountResponse[]>([]);
const payments = ref<{ accountId: string; amount: number }[]>([]);
const saving = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const posted = ref<SaleResponse | null>(null);

const dayStatus = ref<DayStatusResponse | null>(null);
const startingDay = ref(false);
const addingProduct = ref(false);
const newProductName = ref('');
const revealed = ref<string | null>(null);
/*
 * The last look before the sale posts (owner decision 2026-08-25). It carries
 * the total in Bangla words, because a slipped digit is invisible in a figure
 * and unmistakable in a sentence.
 */
const confirming = ref(false);
/*
 * The invoice being corrected, when the counter was opened from Edit Sale.
 *
 * §2.5: a posted sale is never rewritten. The corrected cart posts as a **new**
 * invoice and the original is reversed, so both stay visible and the journal
 * shows exactly what happened. The reversal runs first — if the new sale is
 * then refused, the cart is still on screen to fix and re-post, which is
 * recoverable; the other order could leave two live invoices for one sale.
 */
/*
 * Parked carts (§5.7, owner decision 2026-08-26).
 *
 * A counter is interrupted — the customer goes back for one more item, or
 * leaves to fetch money. Until now the only ways out of a half-built cart were
 * to post it or lose it. A draft is neither: it holds the cart, posts nothing,
 * and is deleted the moment its sale completes.
 */
const drafts = ref<readonly SaleDraftResponse[]>([]);
const showDrafts = ref(false);
const resumedDraftId = ref<string | null>(null);

const correctingSaleId = ref<string | null>(null);
const correctingNumber = ref('');
const confirmingNegative = ref(false);

/** One key per sale, reused on retry, so two taps post one invoice (UI-34). */
const operationId = ref(Ulid.generate(clock));

const canSell = computed(() => session.can('sale.invoice.create'));
const canSeeCost = computed(() => session.can('inventory.cost.view'));
const canEditPrice = computed(() => session.can('sale.price.edit'));
const canDiscount = computed(() => session.can('sale.discount.apply'));

/* ------------------------------------------------------------------ totals */
/* All of it derived, so a keystroke anywhere moves every figure at once. */
const totals = computed(() => cartTotals(lines.value, discount.value, paidMinor.value));
const paidMinor = computed(() =>
  payments.value.reduce((sum, payment) => sum + Math.round(payment.amount * 100), 0),
);
const dueMinor = computed(() => totals.value.dueMinor);
const changeMinor = computed(() => totals.value.changeMinor);
const grandTotalMinor = computed(() => totals.value.grandTotalMinor);
const inWords = computed(() => amountInWords(grandTotalMinor.value, 'BN'));

/** What the confirmation shows: the decision, not the whole cart. */
const confirmFacts = computed(() => [
  { label: 'Items', value: String(lines.value.length) },
  { label: 'Received — পেলেন', value: taka(paidMinor.value) },
  ...(dueMinor.value > 0 ? [{ label: 'Due — বাকি', value: taka(dueMinor.value) }] : []),
  ...(changeMinor.value > 0 ? [{ label: 'Change — ফেরত', value: taka(changeMinor.value) }] : []),
  { label: 'Customer', value: customerName.value.trim() === '' ? 'Walk-in' : customerName.value },
]);

const readyToSell = computed(
  () =>
    canSell.value &&
    lines.value.length > 0 &&
    grandTotalMinor.value > 0 &&
    lines.value.every((line) => line.qty > 0) &&
    payments.value.every((payment) => payment.amount <= 0 || payment.accountId !== '') &&
    (dueMinor.value === 0 || customerReady.value),
);

/* A sale that leaves money owing has to belong to somebody the ledger can
 * name (§5.8) — so the counter is told before it tries, not after. */
const customerReady = computed(
  () => customerId.value !== '' || (customerName.value.trim() !== '' && customerPhone.value.trim() !== ''),
);

const accountOptions = computed(() =>
  accounts.value.map((account) => ({
    value: account.id,
    label: account.name,
    type: account.type,
  })),
);

/** The three most-used accounts get buttons; the rest live behind More. */
const quickAccounts = computed(() => accountOptions.value.slice(0, 3));
const moreAccounts = computed(() => accountOptions.value.slice(3));
const showMoreAccounts = ref(false);

const customerOptions = computed(() =>
  customers.value.map((party) => ({
    value: party.id,
    label: party.phone === null ? party.name : `${party.name} · ${party.phone}`,
  })),
);

const vendorOptions = computed(() =>
  vendors.value.map((party) => ({
    value: party.id,
    label: party.phone === null ? party.name : `${party.name} · ${party.phone}`,
  })),
);

/*
 * UI-09: a capability the shop has switched off is **absent**, not offered and
 * refused. Vendor sourcing was showing its chip and its picker while
 * `vendor_consignment_enabled` was off, so the only way to find out was to be
 * turned down at Complete Sale — with the cart already built.
 */
const consignmentOn = computed(() => session.featureEnabled('vendor_consignment_enabled'));
const canAddVendor = computed(
  () => consignmentOn.value && session.can('party.vendor.create'),
);

function openAddVendor(index: number): void {
  vendorLineIndex.value = index;
  addingVendor.value = true;
}

/** The new vendor is selected on the line that needed it; the cart is untouched. */
async function onVendorCreated(party: PartyResponse): Promise<void> {
  addingVendor.value = false;
  await loadSetup();
  const line = vendorLineIndex.value === null ? undefined : lines.value[vendorLineIndex.value];
  if (line !== undefined) line.vendorPartyId = party.id;
  vendorLineIndex.value = null;
}

const categoryChips = computed(() => [
  { id: '', name: 'All Categories' },
  ...catalog.value.categories.map((category) => ({ id: category.id, name: category.name })),
]);
const brandChips = computed(() => [
  { id: '', name: 'All Brands' },
  ...catalog.value.brands.map((brand) => ({ id: brand.id, name: brand.name })),
]);

/* ------------------------------------------------------------- loading */
async function loadSetup(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    const [accountPage, catalogResponse, customerPage, vendorPage] = await Promise.all([
      fetchAccounts(token),
      fetchCatalog(token),
      fetchParties(token, { role: 'CUSTOMER', status: 'ACTIVE', limit: 200 }),
      // Vendors are only asked for when a line is short, but fetching them with
      // everything else keeps that moment instant at the counter.
      session.featureEnabled('vendor_consignment_enabled') && session.can('party.vendor.view')
        ? fetchParties(token, { role: 'VENDOR', status: 'ACTIVE', limit: 200 })
        : Promise.resolve({ data: [] as readonly PartyResponse[] }),
    ]);
    accounts.value = accountPage.accounts.filter((account) => account.status === 'ACTIVE');
    catalog.value = catalogResponse;
    customers.value = customerPage.data;
    vendors.value = vendorPage.data;
    const drawer = accounts.value.find((account) => account.isDrawer);
    if (payments.value.length === 0) {
      payments.value = [{ accountId: drawer?.id ?? accounts.value[0]?.id ?? '', amount: 0 }];
    }
  } catch (cause) {
    failure.value = describe(cause, 'Could not load the counter');
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;

async function loadProducts(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loadingProducts.value = true;
  try {
    const page = await fetchPosProducts(token, {
      ...(search.value.trim() === '' ? {} : { search: search.value.trim() }),
      ...(categoryId.value === '' ? {} : { categoryId: categoryId.value }),
      ...(brandId.value === '' ? {} : { brandId: brandId.value }),
      ...(customerId.value === '' ? {} : { customerPartyId: customerId.value }),
      limit: 24,
    });
    products.value = page.items;
  } catch (cause) {
    failure.value = describe(cause, 'Could not load products');
  } finally {
    loadingProducts.value = false;
  }
}

/* Typing filters the grid as the shopkeeper types, debounced only enough to
 * keep one request per pause rather than one per character. */
watch(search, () => {
  highlighted.value = 0;
});

watch([search, categoryId, brandId], () => {
  if (searchTimer !== null) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => void loadProducts(), 180);
});

watch(customerId, async (value) => {
  standing.value = null;
  const token = session.accessToken.value;
  if (token === null || value === '') return;
  const party = customers.value.find((row) => row.id === value);
  if (party !== undefined) {
    customerName.value = party.name;
    customerPhone.value = party.phone ?? '';
  }
  try {
    standing.value = await fetchCustomerStanding(token, value);
  } catch {
    standing.value = null;
  }
  await loadProducts();
});

/* ------------------------------------------------------------------ cart */
function priceOf(product: PosProduct): number {
  // A customer group's price wins when dealer pricing is on and one applies
  // (§5.7); everyone else pays the marked selling price.
  return (product.groupPriceMinor ?? product.sellingPriceMinor) / 100;
}

function addToCart(product: PosProduct): void {
  const existing = lines.value.find((line) => line.productId === product.id);
  // Scanning the same barcode twice increments the line rather than making a
  // second one (§5.7's barcode rule); tapping a tile behaves the same way.
  if (existing !== undefined) {
    existing.qty += 1;
    return;
  }
  lines.value.push({
    productId: product.id,
    productName: product.name,
    unitName: product.unitName,
    qty: 1,
    price: priceOf(product),
    lineDiscount: 0,
    qtyOnHand: product.qtyOnHand,
    purchasePriceMinor: product.purchasePriceMinor ?? null,
    source: 'OWN_STOCK',
    allowNegative: false,
    vendorPartyId: '',
    vendorUnitCost: 0,
    showDetail: false,
  });
}

/**
 * Answering a shortage.
 *
 * **Own Stock** means "sell only what is on the shelf", so it brings the
 * quantity down to what is actually there — the shortage disappears because the
 * sale changed, which is what the shopkeeper asked for by choosing it.
 *
 * **With nothing on the shelf, "what is actually there" is no line at all**, so
 * the item leaves the cart. It used to be clamped to a floor of 0.001 to keep a
 * quantity from reaching zero, which put a thousandth of a fridge on the bill
 * (owner-reported 2026-08-26) — a sale nobody meant to make and a figure nobody
 * could read.
 *
 * **Negative Stock** marks *this* line, so the sale posts with the cost
 * provisional (D-19). **Vendor Sourcing** hands the line to a vendor instead.
 */
function useOwnStock(line: CartLine): void {
  const available = Math.round(line.qtyOnHand) / 1000;
  if (available <= 0) {
    const index = lines.value.indexOf(line);
    if (index !== -1) removeLine(index);
    return;
  }
  line.source = 'OWN_STOCK';
  line.allowNegative = false;
  line.qty = available;
}

function useVendor(line: CartLine): void {
  line.source = 'VENDOR_CONSIGNMENT';
  line.allowNegative = false;
}

function useNegative(line: CartLine): void {
  line.source = 'OWN_STOCK';
  line.allowNegative = true;
}

function removeLine(index: number): void {
  lines.value.splice(index, 1);
}

/** Stock left after this cart — the number the fulfilment block asks about. */
function shortageOf(line: CartLine): number {
  return Math.max(line.qty * 1000 - line.qtyOnHand, 0);
}

/**
 * The eye (owner decision 2026-08-25): the product's purchase price, shown for
 * 500 ms with a soft fade, so a customer leaning over the counter sees a
 * flicker rather than a figure. Absent entirely without `inventory.cost.view`,
 * and the server never sends the number to such a user either.
 */
function reveal(productId: string): void {
  revealed.value = productId;
  setTimeout(() => {
    if (revealed.value === productId) revealed.value = null;
  }, 1200);
}

/* --------------------------------------------------------------- payment */
function addPaymentRow(): void {
  payments.value.push({ accountId: accounts.value[0]?.id ?? '', amount: 0 });
}

function removePaymentRow(index: number): void {
  payments.value.splice(index, 1);
}

/** The remainder, offered as one tap so nobody types the total by hand. */
function payExact(index: number): void {
  const others = payments.value.reduce(
    (sum, payment, at) => (at === index ? sum : sum + Math.round(payment.amount * 100)),
    0,
  );
  const row = payments.value[index];
  if (row !== undefined) row.amount = Math.max(grandTotalMinor.value - others, 0) / 100;
}

function accountCodeOf(accountId: string): string | null {
  const account = accounts.value.find((row) => row.id === accountId);
  if (account === undefined) return null;
  return account.type === 'CASH' ? `CASH:${account.id}` : `BANK:${account.id}`;
}

/* ------------------------------------------------------------------ save */
async function completeSale(force = false): Promise<void> {
  const allowNegativeStock = force || lines.value.some((line) => line.allowNegative);
  const token = session.accessToken.value;
  if (token === null || !readyToSell.value) return;

  saving.value = true;
  failure.value = null;
  try {
    if (correctingSaleId.value !== null) {
      const original = await fetchSale(token, correctingSaleId.value);
      await cancelSale(token, original.id, original.version, 'Corrected at the counter');
      correctingSaleId.value = null;
    }
    const saleLines: SaleLineRequest[] = lines.value.map((line) => ({
      productId: line.productId,
      qty: Math.round(line.qty * 1000),
      unitPriceMinor: Math.round(line.price * 100),
      lineDiscountMinor: Math.round(line.lineDiscount * 100),
      source: line.source,
      vendorPartyId: line.source === 'VENDOR_CONSIGNMENT' ? line.vendorPartyId : null,
      vendorUnitCostMinor:
        line.source === 'VENDOR_CONSIGNMENT' ? Math.round(line.vendorUnitCost * 100) : null,
    }));

    const salePayments: SalePaymentRequest[] = payments.value
      .filter((payment) => payment.amount > 0)
      .map((payment) => ({
        accountCode: accountCodeOf(payment.accountId) ?? '',
        amountMinor: Math.round(payment.amount * 100),
      }));

    const sale = await createSale(
      token,
      {
        partyId: customerId.value === '' ? null : customerId.value,
        customerName: customerName.value.trim() === '' ? null : customerName.value.trim(),
        customerPhone: customerPhone.value.trim() === '' ? null : customerPhone.value.trim(),
        customerGuardianName: guardianName.value.trim() === '' ? null : guardianName.value.trim(),
        customerAddress: address.value.trim() === '' ? null : address.value.trim(),
        saveAsCustomer: false,
        dueDate: dueDate.value === '' ? null : dueDate.value,
        lines: saleLines,
        discountMinor: Math.round(discount.value * 100),
        payments: salePayments,
        // Money over the bill is handed back across the counter unless the
        // shopkeeper is deliberately holding it (§5.8).
        overpaymentHandling: 'CHANGE',
        allowNegativeStock,
        notes: notes.value.trim() === '' ? null : notes.value.trim(),
        sourceQuotationId: null,
        sourceOrderId: null,
      },
      operationId.value,
    );
    posted.value = sale;
    if (resumedDraftId.value !== null) {
      await deleteSaleDraft(token, resumedDraftId.value);
      resumedDraftId.value = null;
      await loadDrafts();
    }
  } catch (cause) {
    if (cause instanceof ApiError && cause.details['reason'] === 'CASH_DAY_NOT_STARTED') {
      // The cart is untouched: `দিন শুরু করুন` is offered here, and the same
      // save runs again afterwards (owner decision 2026-08-25).
      await offerStartDay();
      return;
    }
    if (cause instanceof ApiError && cause.details['reason'] === 'NEGATIVE_STOCK_CONFIRM') {
      failure.value = { code: 'NEGATIVE_STOCK_CONFIRM', message: cause.message };
      return;
    }
    failure.value = describe(cause, 'Could not complete this sale');
  } finally {
    saving.value = false;
  }
}

/** The cart as it stands, parked under a name the shopkeeper will recognise. */
async function parkDraft(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || lines.value.length === 0) return;
  confirming.value = false;
  saving.value = true;
  try {
    const named = customerName.value.trim();
    await saveSaleDraft(token, {
      label: named === '' ? `${String(lines.value.length)} items · ${taka(grandTotalMinor.value)}` : named,
      customerName: named === '' ? null : named,
      itemCount: lines.value.length,
      grandTotalMinor: grandTotalMinor.value,
      cart: {
        lines: lines.value,
        discount: discount.value,
        payments: payments.value,
        customerId: customerId.value,
        customerName: customerName.value,
        customerPhone: customerPhone.value,
        guardianName: guardianName.value,
        address: address.value,
        dueDate: dueDate.value,
        notes: notes.value,
      },
    });
    await loadDrafts();
    startNextSale();
  } catch (cause) {
    failure.value = describe(cause, 'Could not save this draft');
  } finally {
    saving.value = false;
  }
}

async function loadDrafts(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    drafts.value = await fetchSaleDrafts(token);
  } catch {
    // The counter works without its drafts list; its own failure is not worth
    // a banner over the till.
    drafts.value = [];
  }
}

/** A parked cart comes back exactly as it was left. */
function resumeDraft(draft: SaleDraftResponse): void {
  const cart = draft.cart as {
    lines?: CartLine[];
    discount?: number;
    payments?: { accountId: string; amount: number }[];
    customerId?: string;
    customerName?: string;
    customerPhone?: string;
    guardianName?: string;
    address?: string;
    dueDate?: string;
    notes?: string;
  };
  lines.value = cart.lines ?? [];
  discount.value = cart.discount ?? 0;
  payments.value = cart.payments ?? payments.value;
  customerId.value = cart.customerId ?? '';
  customerName.value = cart.customerName ?? '';
  customerPhone.value = cart.customerPhone ?? '';
  guardianName.value = cart.guardianName ?? '';
  address.value = cart.address ?? '';
  dueDate.value = cart.dueDate ?? '';
  notes.value = cart.notes ?? '';
  resumedDraftId.value = draft.id;
  showDrafts.value = false;
}

async function dropDraft(draft: SaleDraftResponse): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    await deleteSaleDraft(token, draft.id);
    if (resumedDraftId.value === draft.id) resumedDraftId.value = null;
    await loadDrafts();
  } catch (cause) {
    failure.value = describe(cause, 'Could not delete that draft');
  }
}

async function onConfirmSale(): Promise<void> {
  confirming.value = false;
  await completeSale();
}

async function onConfirmNegative(): Promise<void> {
  confirmingNegative.value = false;
  await completeSale(true);
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
  await completeSale();
}

/** A finished sale clears the counter for the next customer. */
function startNextSale(): void {
  posted.value = null;
  lines.value = [];
  discount.value = 0;
  notes.value = '';
  dueDate.value = '';
  customerId.value = '';
  customerName.value = '';
  customerPhone.value = '';
  guardianName.value = '';
  address.value = '';
  standing.value = null;
  payments.value = payments.value.slice(0, 1).map((payment) => ({ ...payment, amount: 0 }));
  operationId.value = Ulid.generate(clock);
  void loadProducts();
  void focusSearch();
}

async function focusSearch(): Promise<void> {
  await nextTick();
  document.getElementById('pos-search')?.focus();
}

/**
 * Enter adds what the counter is looking at.
 *
 * A scanner ends its scan with Enter, so an exact barcode always wins — the
 * scanner is never guessing. Otherwise it takes the highlighted tile, which is
 * the first (best-ranked) one until the arrow keys move it. A single match
 * needs no highlighting to be obvious, and behaves the same way.
 */
async function onSearchEnter(): Promise<void> {
  if (shown.value.length === 0) return;
  const typed = searchTokens(search.value).join('');
  const exact = shown.value.find(
    (product) => (product.barcode ?? '').toLowerCase() === typed,
  );
  const chosen = exact ?? shown.value[highlighted.value] ?? shown.value[0];
  if (chosen === undefined) return;
  addToCart(chosen);
  clearSearch();
  await focusSearch();
}

function clearSearch(): void {
  search.value = '';
  highlighted.value = 0;
}

/** Arrow keys walk the grid without the hands leaving the search box. */
function moveHighlight(by: number): void {
  if (shown.value.length === 0) return;
  const next = highlighted.value + by;
  highlighted.value = Math.min(Math.max(next, 0), shown.value.length - 1);
  document.getElementById(`pos-tile-${String(highlighted.value)}`)?.scrollIntoView({
    block: 'nearest',
  });
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'F4' && readyToSell.value && !saving.value) {
    event.preventDefault();
    confirming.value = true;
  }
}

function openAddProduct(): void {
  newProductName.value = search.value.trim();
  addingProduct.value = true;
}

async function onProductCreated(): Promise<void> {
  addingProduct.value = false;
  await loadProducts();
}

/** Scale-3 quantity as a shopkeeper writes it: 5, not 5.000. */
function qtyText(raw: number): string {
  return String(Math.round(raw) / 1000);
}

function stockLabel(product: PosProduct): string {
  const qty = qtyText(product.qtyOnHand);
  if (product.stockStatus === 'ZERO_STOCK') return 'Out of stock';
  if (product.stockStatus === 'LOW_STOCK') return `Low stock (${qty})`;
  if (product.stockStatus === 'NEGATIVE_STOCK') return `Negative (${qty})`;
  return `In stock (${qty})`;
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  if (cause instanceof ApiError) return { code: cause.code, message: cause.message };
  return { code: 'UNKNOWN', message: fallback };
}

/**
 * Opening the counter on an invoice that is being corrected.
 *
 * Its lines, customer, discount and payments come back exactly as they were
 * posted, so the shopkeeper changes what is wrong rather than retyping a bill.
 */
async function loadForCorrection(saleId: string): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  try {
    const sale = await fetchSale(token, saleId);
    if (sale.status === 'VOIDED') {
      failure.value = { code: 'VALIDATION_FAILED', message: 'That invoice is already cancelled' };
      return;
    }

    correctingSaleId.value = sale.id;
    correctingNumber.value = sale.number;
    customerId.value = sale.isWalkIn ? '' : sale.partyId;
    customerName.value = sale.customerName;
    customerPhone.value = sale.customerPhone ?? '';
    guardianName.value = sale.customerGuardianName ?? '';
    address.value = sale.customerAddress ?? '';
    dueDate.value = sale.dueDate ?? '';
    notes.value = sale.notes ?? '';
    discount.value = sale.discountMinor / 100;

    lines.value = sale.lines.map((line) => ({
      productId: line.productId,
      productName: line.productName,
      unitName: line.unitName,
      qty: line.qty / 1000,
      price: line.unitPriceMinor / 100,
      lineDiscount: line.lineDiscountMinor / 100,
      // Refreshed by the grid as soon as it loads; the posted line carries no
      // stock figure, and guessing one would show a false shortage.
      qtyOnHand: 0,
      purchasePriceMinor: null,
      source: line.source,
      allowNegative: line.isProvisionalCost,
      vendorPartyId: line.vendorPartyId ?? '',
      vendorUnitCost: 0,
      showDetail: false,
    }));

    payments.value = sale.payments.map((payment) => ({
      accountId: payment.accountCode.slice(payment.accountCode.indexOf(':') + 1),
      amount: payment.amountMinor / 100,
    }));
    if (payments.value.length === 0) {
      payments.value = [{ accountId: accounts.value.find((a) => a.isDrawer)?.id ?? '', amount: 0 }];
    }
  } catch (cause) {
    failure.value = describe(cause, 'Could not open that invoice for correction');
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  await loadSetup();
  await loadProducts();
  await loadDrafts();
  const editing = route.query['edit'];
  if (typeof editing === 'string' && editing.length === 26) await loadForCorrection(editing);
  /*
   * Opened from a customer's hub with `?customer=<id>`: the cart starts on that
   * person, so "New sale" from their ledger lands at the counter with them
   * already chosen instead of asking who they are again (§5.6).
   */
  const forCustomer = route.query['customer'];
  if (typeof forCustomer === 'string' && forCustomer.length === 26 && customerId.value === '') {
    customerId.value = forCustomer;
  }
  await focusSearch();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  if (searchTimer !== null) clearTimeout(searchTimer);
});
</script>

<template>
  <AppShell title="POS — New Sale" help-bn="নতুন বিক্রি">
    <div class="pos">
      <!-- One bar, always ready: type a name, or let the scanner type for you. -->
      <div class="scanbar">
        <i class="pi pi-search scanbar__icon" aria-hidden="true" />
        <input
          id="pos-search"
          v-model="search"
          class="scanbar__input"
          type="search"
          inputmode="search"
          enterkeyhint="done"
          placeholder="Scan barcode, or type any part of a name, brand or code…"
          autocomplete="off"
          autocapitalize="off"
          autocorrect="off"
          spellcheck="false"
          @keydown.enter.prevent="onSearchEnter"
          @keydown.down.prevent="moveHighlight(1)"
          @keydown.up.prevent="moveHighlight(-1)"
          @keydown.esc.prevent="clearSearch"
        />
        <button
          v-if="search !== ''"
          type="button"
          class="scanbar__clear"
          title="Clear (Esc)"
          @click="clearSearch(); void focusSearch()"
        >
          <i class="pi pi-times" />
        </button>
        <button
          v-if="drafts.length > 0"
          type="button"
          class="scanbar__drafts"
          @click="showDrafts = true"
        >
          <i class="pi pi-inbox" /> Drafts ({{ drafts.length }})
        </button>
        <button
          v-if="session.can('catalog.product.create')"
          type="button"
          class="scanbar__add"
          title="Add a product"
          @click="openAddProduct"
        >
          <i class="pi pi-plus" />
        </button>
      </div>

      <div v-if="correctingSaleId" class="warnbar">
        <div>
          <p class="warnbar__title">Correcting invoice {{ correctingNumber }}</p>
          <p class="warnbar__detail">
            Completing this sale reverses that invoice and posts this cart in its place. Both stay
            visible.
          </p>
        </div>
        <button type="button" class="btn btn-ghost" @click="router.push({ name: 'sales' })">
          Leave it alone
        </button>
      </div>

      <ErrorNotice
        v-if="failure && failure.code !== 'NEGATIVE_STOCK_CONFIRM'"
        :code="failure.code"
        :message="failure.message"
      />
      <div v-if="failure?.code === 'NEGATIVE_STOCK_CONFIRM'" class="warnbar">
        <div>
          <p class="warnbar__title">Not enough stock</p>
          <p class="warnbar__detail">{{ failure.message }}</p>
        </div>
        <button type="button" class="btn btn-primary" @click="confirmingNegative = true">
          Sell anyway <span class="label-bn on-primary">তবুও বিক্রি করুন</span>
        </button>
      </div>

      <div class="pos__body">
        <!-- ------------------------------------------------ the catalogue -->
        <section class="panel catalogue">
          <div class="catalogue__filters">
            <div class="chips">
              <button
                v-for="chip in categoryChips"
                :key="`c-${chip.id}`"
                type="button"
                class="chip"
                :class="{ 'chip--on': categoryId === chip.id }"
                @click="categoryId = chip.id"
              >
                {{ chip.name }}
              </button>
            </div>
            <div class="catalogue__viewtoggle">
              <button
                type="button"
                class="seg"
                :class="{ 'seg--on': view === 'GRID' }"
                @click="view = 'GRID'"
              >
                <i class="pi pi-th-large" /> Grid
              </button>
              <button
                type="button"
                class="seg"
                :class="{ 'seg--on': view === 'LIST' }"
                @click="view = 'LIST'"
              >
                <i class="pi pi-list" /> List
              </button>
            </div>
          </div>
          <div class="chips chips--quiet">
            <button
              v-for="chip in brandChips"
              :key="`b-${chip.id}`"
              type="button"
              class="chip chip--sm"
              :class="{ 'chip--on': brandId === chip.id }"
              @click="brandId = chip.id"
            >
              {{ chip.name }}
            </button>
          </div>

          <p v-if="loadingProducts && shown.length === 0" class="muted">Loading…</p>
          <p v-else-if="shown.length === 0" class="empty">
            Nothing matched “{{ search }}”. Try another name, or add the product with
            <strong>+</strong> above.
          </p>

          <div v-else :class="view === 'GRID' ? 'grid' : 'list'">
            <button
              v-for="(product, index) in shown"
              :id="`pos-tile-${String(index)}`"
              :key="product.id"
              type="button"
              class="tile"
              :class="{ 'tile--on': index === highlighted }"
              @click="addToCart(product)"
              @mouseenter="highlighted = index"
            >
              <span class="tile__image">
                <img
                  v-if="product.hasImage"
                  :src="`/api/v1/products/${product.id}/image`"
                  :alt="product.name"
                />
                <span v-else class="tile__letters">{{ product.name.slice(0, 2) }}</span>
              </span>
              <span class="tile__text">
                <span class="tile__name">{{ product.name }}</span>
                <span class="tile__meta">
                  {{ product.brandName ?? '—' }} · {{ product.unitName }}
                </span>
                <span class="tile__foot">
                  <span class="tile__price">
                    {{ taka(product.groupPriceMinor ?? product.sellingPriceMinor) }}
                  </span>
                  <span class="stock" :class="`stock--${product.stockStatus.toLowerCase()}`">
                    {{ stockLabel(product) }}
                  </span>
                </span>
              </span>
            </button>
          </div>
        </section>

        <!-- ------------------------------------------------------ the cart -->
        <aside class="panel cart">
          <div class="cart__customer">
            <div class="grid-2">
              <label class="field">
                <span>Customer Name <span class="label-bn">কাস্টমারের নাম</span></span>
                <InputText v-model="customerName" placeholder="Walk-in customer" />
              </label>
              <label class="field">
                <span>Phone <span class="label-bn">ফোন নম্বর</span></span>
                <InputText v-model="customerPhone" placeholder="01XXXXXXXXX" />
              </label>
            </div>

            <Select
              v-model="customerId"
              :options="customerOptions"
              option-label="label"
              option-value="value"
              filter
              show-clear
              placeholder="Or pick a saved customer"
              class="cart__pick"
            />

            <p v-if="standing && standing.dueMinor > 0" class="standing standing--due">
              <span>Outstanding Due <span class="label-bn">আগের বাকি</span></span>
              <strong>{{ taka(standing.dueMinor) }}</strong>
            </p>
            <p v-else-if="standing && standing.advanceMinor > 0" class="standing standing--advance">
              <span>Advance held <span class="label-bn">জমা আছে</span></span>
              <strong>{{ taka(standing.advanceMinor) }}</strong>
            </p>

            <div class="cart__customer-links">
              <button type="button" class="linkish" @click="showMoreCustomer = !showMoreCustomer">
                {{ showMoreCustomer ? '− Father name / address' : '+ Father name / address' }}
              </button>
              <button
                type="button"
                class="linkish"
                :disabled="customerPhone.trim() === ''"
                @click="router.push({ name: 'sales', query: { search: customerPhone } })"
              >
                Sales history for this phone
              </button>
            </div>

            <div v-if="showMoreCustomer" class="grid-2">
              <label class="field">
                <span>Father Name <span class="label-bn">বাবার নাম</span></span>
                <InputText v-model="guardianName" placeholder="Optional" />
              </label>
              <label class="field">
                <span>Address <span class="label-bn">ঠিকানা</span></span>
                <InputText v-model="address" placeholder="Optional" />
              </label>
            </div>
          </div>

          <div class="cart__lines">
            <div v-if="lines.length === 0" class="cart__empty">
              <i class="pi pi-shopping-cart" />
              <p>Scan or tap a product to start this sale.</p>
            </div>

            <template v-else>
              <div class="cart__head">
                <span>Item <span class="label-bn">পণ্য</span></span>
                <span>Qty</span>
                <span>Price</span>
                <span class="num">Total</span>
                <span />
              </div>

              <div v-for="(line, index) in lines" :key="line.productId" class="cart__line">
                <div class="cart__line-main">
                  <div class="cart__line-name">
                    <span class="cart__line-title" :title="line.productName">
                      {{ line.productName }}
                    </span>
                    <!--
                      The eye's reveal takes the unit's place for half a second
                      rather than appearing beside it: nothing moves, nothing
                      overlaps, and a customer across the counter sees a flicker.
                    -->
                    <span class="cart__line-sub">
                      {{ line.unitName }}
                      <span
                        v-if="revealed === line.productId && line.purchasePriceMinor !== null"
                        class="cart__cost"
                      >
                        {{ taka(line.purchasePriceMinor) }}
                      </span>
                    </span>
                  </div>
                  <AmountInput
                    v-model="line.qty"
                    :min="0.001"
                    :fraction-digits="3"
                    show-buttons
                    align="left"
                    class="cart__qty"
                  />
                  <AmountInput v-model="line.price" :disabled="!canEditPrice" class="cart__price" />
                  <span class="cart__line-total">
                    {{ taka(totals.lines[index]?.lineTotalMinor ?? 0) }}
                  </span>
                  <div class="cart__line-tools">
                    <button
                      v-if="canSeeCost"
                      type="button"
                      class="icon-btn cart__eye"
                      title="Show purchase price"
                      @click="reveal(line.productId)"
                    >
                      <i class="pi pi-eye" />
                    </button>
                    <button
                      type="button"
                      class="icon-btn icon-btn--danger"
                      title="Remove"
                      @click="removeLine(index)"
                    >
                      <i class="pi pi-times" />
                    </button>
                  </div>
                </div>

                <div v-if="canDiscount" class="cart__line-extra">
                  <button type="button" class="linkish" @click="line.showDetail = !line.showDetail">
                    {{ line.showDetail ? 'Hide item discount' : 'Discount on this item' }}
                  </button>
                  <AmountInput
                    v-if="line.showDetail"
                    v-model="line.lineDiscount"
                    class="cart__line-discount"
                  />
                </div>

                <!-- Not enough on the shelf: say so, and offer the three ways out. -->
                <div v-if="shortageOf(line) > 0" class="shortage">
                  <div class="shortage__head">
                    <strong>Stock short by {{ qtyText(shortageOf(line)) }}</strong>
                    <span>{{ qtyText(line.qtyOnHand) }} own stock available</span>
                  </div>
                  <div class="chips">
                    <button
                      type="button"
                      class="chip chip--sm"
                      :class="{ 'chip--on': line.source === 'OWN_STOCK' && !line.allowNegative }"
                      @click="useOwnStock(line)"
                    >
                      Own Stock
                    </button>
                    <button
                      v-if="consignmentOn"
                      type="button"
                      class="chip chip--sm"
                      :class="{ 'chip--on': line.source === 'VENDOR_CONSIGNMENT' }"
                      @click="useVendor(line)"
                    >
                      Vendor Sourcing
                    </button>
                    <button
                      type="button"
                      class="chip chip--sm"
                      :class="{ 'chip--on': line.allowNegative }"
                      @click="useNegative(line)"
                    >
                      Negative Stock
                    </button>
                  </div>
                  <div v-if="consignmentOn && line.source === 'VENDOR_CONSIGNMENT'" class="shortage__vendor">
                    <Select
                      v-model="line.vendorPartyId"
                      :options="vendorOptions"
                      option-label="label"
                      option-value="value"
                      filter
                      placeholder="Which vendor — কোন ভেন্ডার"
                      class="shortage__vendor-pick"
                    />
                    <button
                      v-if="canAddVendor"
                      type="button"
                      class="icon-btn"
                      title="Add a vendor"
                      @click="openAddVendor(index)"
                    >
                      <i class="pi pi-plus" />
                    </button>
                    <AmountInput
                      v-model="line.vendorUnitCost"
                      placeholder="Their cost / unit"
                      class="shortage__vendor-cost"
                    />
                  </div>
                </div>
              </div>
            </template>
          </div>

          <!-- Totals. Every one of these moves on every keystroke above. -->
          <div class="totals">
            <div class="totals__row">
              <span>Subtotal <span class="label-bn">মোট টাকা</span></span>
              <span class="num">{{ taka(totals.itemsTotalMinor) }}</span>
            </div>
            <div class="totals__row">
              <span>Discount <span class="label-bn">ডিসকাউন্ট</span></span>
              <AmountInput v-model="discount" :disabled="!canDiscount" class="totals__input" />
            </div>
            <div class="totals__row totals__row--grand">
              <span>Grand Total <span class="label-bn">সর্বমোট টাকা</span></span>
              <span class="num">{{ taka(grandTotalMinor) }}</span>
            </div>
            <p class="totals__words">{{ inWords }}</p>
          </div>

          <!-- Payment: the method, then the account the money actually landed in. -->
          <div class="pay">
            <div v-for="(payment, index) in payments" :key="index" class="pay__row">
              <Select
                v-model="payment.accountId"
                :options="showMoreAccounts ? accountOptions : quickAccounts"
                option-label="label"
                option-value="value"
                placeholder="Payment method — কীভাবে টাকা নিলেন"
                class="pay__method"
              />
              <AmountInput
                v-model="payment.amount"
                placeholder="Blank = full due"
                class="pay__amount"
              />
              <button type="button" class="icon-btn" title="Exact amount" @click="payExact(index)">
                <i class="pi pi-equals" />
              </button>
              <button
                v-if="payments.length > 1"
                type="button"
                class="icon-btn icon-btn--danger"
                title="Remove this payment"
                @click="removePaymentRow(index)"
              >
                <i class="pi pi-trash" />
              </button>
            </div>
            <div class="pay__links">
              <button type="button" class="linkish" @click="addPaymentRow">+ Add payment</button>
              <button
                v-if="moreAccounts.length > 0"
                type="button"
                class="linkish"
                @click="showMoreAccounts = !showMoreAccounts"
              >
                {{ showMoreAccounts ? 'Fewer accounts' : 'More accounts' }}
              </button>
            </div>
          </div>

          <div class="totals totals--settle">
            <div class="totals__row">
              <span>Amount Received <span class="label-bn">কত টাকা পেলেন</span></span>
              <span class="num">{{ taka(paidMinor) }}</span>
            </div>
            <div v-if="dueMinor > 0" class="totals__row totals__row--due">
              <span>Due Amount <span class="label-bn">বাকি থাকলো</span></span>
              <span class="num">{{ taka(dueMinor) }}</span>
            </div>
            <div v-if="changeMinor > 0" class="totals__row totals__row--change">
              <span>Change <span class="label-bn">ফেরত</span></span>
              <span class="num">{{ taka(changeMinor) }}</span>
            </div>
          </div>

          <p v-if="dueMinor > 0 && !customerReady" class="hint">
            A sale that leaves money owing needs the customer’s name and phone.
          </p>

          <button
            type="button"
            class="complete"
            :disabled="!readyToSell || saving"
            @click="confirming = true"
          >
            <span class="complete__en">
              {{ saving ? 'Completing…' : 'Complete Sale (F4)' }}
            </span>
            <span class="complete__bn">সেল সম্পন্ন করুন</span>
          </button>
        </aside>
      </div>
    </div>

    <ConfirmDialog
      v-if="confirming"
      :title="correctingSaleId ? `Replace invoice ${correctingNumber}?` : 'Complete this sale?'"
      :message="
        correctingSaleId
          ? 'The original invoice is reversed and this cart is posted in its place.'
          : 'Check the amount below before it is posted.'
      "
      :amount-minor="grandTotalMinor"
      :facts="confirmFacts"
      confirm-label="Complete Sale"
      confirm-label-bn="সেল সম্পন্ন করুন"
      :busy="saving"
      secondary-label="Save as draft"
      secondary-label-bn="খসড়া রাখুন"
      @cancel="confirming = false"
      @secondary="parkDraft"
      @confirm="onConfirmSale"
    />

    <div v-if="showDrafts" class="scrim" @click.self="showDrafts = false">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>Parked carts <span class="label-bn">খসড়া বিল</span></h2>
        <p class="lede">
          A draft holds a cart and posts nothing. Resuming one brings it back exactly as it was
          left; completing that sale removes it.
        </p>
        <ul class="drafts">
          <li v-for="draft in drafts" :key="draft.id">
            <button type="button" class="drafts__open" @click="resumeDraft(draft)">
              <span class="drafts__label">{{ draft.label }}</span>
              <span class="drafts__meta">
                {{ draft.itemCount }} items · {{ taka(draft.grandTotalMinor) }} ·
                {{ draft.businessDate }}
              </span>
            </button>
            <button
              type="button"
              class="icon-btn icon-btn--danger"
              title="Delete this draft"
              @click="dropDraft(draft)"
            >
              <i class="pi pi-trash" />
            </button>
          </li>
        </ul>
        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" @click="showDrafts = false">Close</button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      v-if="confirmingNegative"
      title="Sell more than you have?"
      message="This posts a sale for stock that is not on the shelf. Its cost stays provisional until the goods are bought."
      :amount-minor="grandTotalMinor"
      danger
      confirm-label="Sell anyway"
      confirm-label-bn="তবুও বিক্রি করুন"
      :busy="saving"
      @cancel="confirmingNegative = false"
      @confirm="onConfirmNegative"
    />

    <InvoicePreviewDialog
      v-if="posted"
      :sale="posted"
      @close="startNextSale"
      @updated="(sale: SaleResponse) => (posted = sale)"
    />

    <StartDayDialog
      v-if="startingDay && dayStatus"
      :status="dayStatus"
      @close="startingDay = false"
      @started="onDayStarted"
    />

    <!-- A vendor who is not on the list yet, without losing the cart (UI-50). -->
    <Dialog
      v-model:visible="addingVendor"
      modal
      header="Add vendor — নতুন ভেন্ডার"
      :style="{ width: 'min(46rem, 96vw)' }"
    >
      <PartyFormPage
        embedded
        embedded-role="VENDOR"
        @saved="onVendorCreated"
        @close="addingVendor = false"
      />
    </Dialog>

    <Dialog
      v-model:visible="addingProduct"
      modal
      header="Add product — নতুন পণ্য"
      :style="{ width: 'min(52rem, 96vw)' }"
    >
      <ProductForm
        :product-id="null"
        @close="addingProduct = false"
        @saved="onProductCreated"
      />
    </Dialog>
  </AppShell>
</template>

<style scoped>
/*
 * The counter, in the application's own visual system (§2.7.I).
 *
 * Every colour, radius and spacing below resolves to a `--sher-*` token, so
 * this screen looks like the rest of SherERP rather than like a screen written
 * on its own. Two panels on a cool grey page: the catalogue breathes, the cart
 * is dense — a counter reads the cart forty times an hour and the grid once.
 */
.pos {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-3, 12px);
}

/* ---------------------------------------------------------------- scan bar */
.scanbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 12px;
  height: 52px;
  background: var(--sher-raised);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-lg, 12px);
  box-shadow: var(--sher-shadow-sm, 0 1px 2px rgb(15 23 42 / 6%));
}

.scanbar:focus-within {
  border-color: var(--sher-primary);
  box-shadow: 0 0 0 3px var(--sher-primary-soft);
}

.scanbar__icon {
  color: var(--sher-text-faint);
}

.scanbar__input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--sher-text);
  font-size: 15px;
}

.scanbar__input::placeholder {
  color: var(--sher-text-faint);
}

.scanbar__clear {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: none;
  border: none;
  border-radius: 999px;
  background: var(--sher-sunken);
  color: var(--sher-text-muted);
  cursor: pointer;
}

.scanbar__clear:hover {
  background: var(--sher-hover);
  color: var(--sher-text);
}

/* A search box on a phone draws its own clear button; ours is the only one. */
.scanbar__input::-webkit-search-cancel-button {
  display: none;
}

.tile--on {
  border-color: var(--sher-primary);
  box-shadow: 0 0 0 2px var(--sher-primary-soft);
}

.scanbar__drafts {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: none;
  padding: 6px 12px;
  border: 1px solid var(--sher-line);
  border-radius: 999px;
  background: var(--sher-raised);
  color: var(--sher-text);
  font-size: 12px;
  cursor: pointer;
}

.scanbar__drafts:hover {
  background: var(--sher-hover);
}

.drafts {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 40vh;
  overflow-y: auto;
}

.drafts li {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-md, 10px);
  padding: 4px 6px 4px 10px;
}

.drafts__open {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  text-align: left;
  padding: 4px 0;
}

.drafts__label {
  font-weight: 600;
  font-size: var(--sher-text-sm, 13px);
}

.drafts__meta {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.scanbar__add {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: var(--sher-primary-soft);
  color: var(--sher-primary-text);
  cursor: pointer;
}

.scanbar__add:hover {
  background: var(--sher-primary);
  color: var(--sher-on-primary);
}

/* ------------------------------------------------------------ stock warning */
.warnbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  border-radius: var(--sher-radius-lg, 12px);
  background: var(--sher-warn-soft, #fff7ed);
  border: 1px solid var(--sher-warn, #f59e0b);
}

.warnbar__title {
  margin: 0;
  font-weight: 600;
}

.warnbar__detail {
  margin: 2px 0 0;
  font-size: var(--sher-text-sm, 13px);
  color: var(--sher-text-muted);
}

/* ------------------------------------------------------------------ layout */
.pos__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 27rem);
  gap: var(--sher-space-3, 12px);
  align-items: start;
}

@media (max-width: 68rem) {
  .pos__body {
    grid-template-columns: minmax(0, 1fr);
  }
}

.panel {
  background: var(--sher-raised);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-lg, 12px);
  box-shadow: var(--sher-shadow-sm, 0 1px 2px rgb(15 23 42 / 6%));
  padding: var(--sher-space-4, 16px);
}

/* --------------------------------------------------------------- catalogue */
.catalogue__filters {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chips--quiet {
  margin-bottom: 14px;
}

.chip {
  border: 1px solid var(--sher-line);
  background: var(--sher-raised);
  color: var(--sher-text);
  border-radius: 999px;
  padding: 5px 12px;
  font-size: var(--sher-text-sm, 13px);
  line-height: 1.2;
  cursor: pointer;
  transition: background 120ms ease, border-color 120ms ease;
}

.chip--sm {
  padding: 4px 10px;
  font-size: 12px;
  color: var(--sher-text-muted);
}

.chip:hover {
  background: var(--sher-hover);
}

.chip--on,
.chip--on:hover {
  background: var(--sher-primary);
  border-color: var(--sher-primary);
  color: var(--sher-on-primary);
}

.catalogue__viewtoggle {
  display: flex;
  flex: none;
  padding: 2px;
  border-radius: 8px;
  background: var(--sher-sunken);
  border: 1px solid var(--sher-line);
}

.seg {
  display: flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: transparent;
  color: var(--sher-text-muted);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}

.seg--on {
  background: var(--sher-raised);
  color: var(--sher-text);
  box-shadow: var(--sher-shadow-sm, 0 1px 2px rgb(15 23 42 / 8%));
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
  gap: 8px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tile {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-md, 10px);
  background: var(--sher-raised);
  color: var(--sher-text);
  cursor: pointer;
  text-align: left;
  transition: border-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;
}

.tile:hover {
  border-color: var(--sher-primary);
  box-shadow: var(--sher-shadow-md, 0 4px 12px rgb(15 23 42 / 8%));
  transform: translateY(-1px);
}

.list .tile {
  flex-direction: row;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
}

/* A list row has width to spend, so the name and price are set larger. */
.list .tile__name {
  font-size: 15px;
}

.list .tile__price {
  font-size: 15px;
}

.list .tile__meta {
  font-size: 12px;
}

.tile__image {
  display: grid;
  place-items: center;
  width: 100%;
  height: 68px;
  border-radius: 8px;
  background: var(--sher-sunken);
  overflow: hidden;
}

.list .tile__image {
  width: 60px;
  height: 60px;
  flex: none;
}

.tile__image img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.tile__letters {
  font-size: 16px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--sher-text-faint);
}

.tile__text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.tile__name {
  font-weight: 600;
  font-size: var(--sher-text-sm, 13px);
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tile__meta {
  font-size: 11px;
  color: var(--sher-text-muted);
}

.tile__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 2px;
}

.tile__price {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.stock {
  font-size: 11px;
  border-radius: 999px;
  padding: 2px 7px;
  background: var(--sher-sunken);
  color: var(--sher-text-muted);
  white-space: nowrap;
}

.stock--in_stock {
  background: var(--sher-ok-soft, #ecfdf5);
  color: var(--sher-ok, #047857);
}

.stock--low_stock {
  background: var(--sher-warn-soft, #fff7ed);
  color: var(--sher-warn-text, #b45309);
}

.stock--zero_stock,
.stock--negative_stock {
  background: var(--sher-danger-soft, #fef2f2);
  color: var(--sher-danger, #b91c1c);
}

/* -------------------------------------------------------------------- cart */
.cart {
  position: sticky;
  top: 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.field > span {
  font-size: 12px;
  font-weight: 600;
  color: var(--sher-text);
}

.label-bn::before {
  content: '— ';
}

.label-bn {
  margin-left: 4px;
  font-size: 11px;
  font-weight: 400;
  color: var(--sher-text-muted);
}

.label-bn.on-primary {
  color: inherit;
  opacity: 0.85;
}

.cart__customer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--sher-line);
}

.cart__pick {
  width: 100%;
}

.standing {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 0;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: var(--sher-text-sm, 13px);
}

.standing--due {
  background: var(--sher-danger-soft, #fef2f2);
  color: var(--sher-danger, #b91c1c);
}

.standing--advance {
  background: var(--sher-ok-soft, #ecfdf5);
  color: var(--sher-ok, #047857);
}

.standing strong {
  font-variant-numeric: tabular-nums;
  font-size: 15px;
}

.cart__customer-links {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.cart__lines {
  display: flex;
  flex-direction: column;
  max-height: 38vh;
  overflow-y: auto;
}

.cart__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 22px 0;
  color: var(--sher-text-faint);
}

.cart__empty i {
  font-size: 22px;
}

.cart__empty p {
  margin: 0;
  font-size: var(--sher-text-sm, 13px);
}

/* One product, one line — the headings sit exactly over their boxes. */
.cart__head,
.cart__line-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 5.75rem 4.5rem 3.75rem auto;
  gap: 5px;
  align-items: center;
}

.cart__head {
  padding: 0 0 6px;
  font-size: 11px;
  font-weight: 600;
  color: var(--sher-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.cart__line {
  padding: 7px 0;
  border-top: 1px solid var(--sher-line-soft);
}

.cart__line-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.cart__line-title {
  font-weight: 600;
  font-size: var(--sher-text-sm, 13px);
  line-height: 1.2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cart__line-sub {
  font-size: 11px;
  color: var(--sher-text-muted);
  transition: color 150ms ease-in-out;
}

/*
 * The revealed price: a solid chip beside the unit, brief but unmistakable.
 * Grey text at 11px was invisible against the unit label next to it, which is
 * the opposite of what the eye is for.
 */
.cart__cost {
  margin-left: 5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--sher-text);
  color: var(--sher-raised);
  font-weight: 700;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  animation: cost-flash 120ms ease-out;
}

@keyframes cost-flash {
  from {
    opacity: 0;
    transform: translateY(-1px);
  }
}

.cart__eye {
  width: 1.35rem;
  height: 1.35rem;
  font-size: 11px;
}

/*
 * Stacked arrows (owner decision 2026-08-25): in a cell this narrow the up/down
 * pair sits beside the number instead of stealing width on both sides of it.
 */
.cart__qty :deep(.p-inputnumber-input),
.cart__price :deep(.p-inputnumber-input) {
  height: 34px;
  padding: 0 6px;
}

/*
 * PrimeVue lays the stacked arrows *over* the right edge of the field, so a
 * right-aligned quantity is drawn underneath them and the box reads as empty.
 * The number stays left, and the padding keeps it clear of the arrows.
 */
.cart__qty :deep(.p-inputnumber-input) {
  padding-right: 1.9rem;
}

/*
 * The arrows are there when a hand is (owner decision 2026-08-25): quiet until
 * the row is hovered or the box has focus, so a cart of six lines is six
 * numbers rather than twelve chevrons.
 */
.cart__qty :deep(.p-inputnumber-button) {
  width: 1.5rem;
  color: var(--sher-text-muted);
  opacity: 0;
  transition: opacity 120ms ease-in-out;
}

.cart__line:hover .cart__qty :deep(.p-inputnumber-button),
.cart__qty:focus-within :deep(.p-inputnumber-button) {
  opacity: 1;
}

.cart__line-total {
  text-align: right;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.cart__line-tools {
  display: flex;
  gap: 0;
}

.cart__line-tools .icon-btn {
  width: 1.6rem;
  height: 1.6rem;
}

.cart__line-extra {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
}

.cart__line-discount {
  width: 7rem;
}

.shortage {
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--sher-danger-soft, #fef2f2);
  border: 1px solid var(--sher-danger-line, #fecaca);
}

.shortage__vendor {
  display: flex;
  align-items: center;
  gap: 6px;
}

.shortage__vendor-pick {
  flex: 1;
  min-width: 0;
}

.shortage__vendor-cost {
  width: 7.5rem;
  flex: none;
}

.shortage__head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--sher-danger, #b91c1c);
}

/* ------------------------------------------------------------------ totals */
.totals {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 10px;
  border-top: 1px solid var(--sher-line);
}

.totals--settle {
  border-top-style: dashed;
}

.totals__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--sher-text-sm, 13px);
}

.totals__row .num {
  font-weight: 600;
}

.totals__input {
  width: 8rem;
  max-width: 8rem;
}

/*
 * PrimeVue renders an InputNumber as a wrapper *around* its own <input>, and
 * the inner input keeps a browser default width of roughly 20 characters. A
 * width set on the wrapper alone therefore does nothing to the box that is
 * actually drawn, which is how the discount and cash fields ended up hanging
 * off the edge of the cart. Every amount box in this screen is sized here, once.
 */
:deep(.p-inputnumber) {
  max-width: 100%;
}

:deep(.p-inputnumber-input) {
  width: 100%;
  min-width: 0;
}

.cart__qty,
.cart__price {
  width: 100%;
}

.totals__row--grand {
  margin-top: 2px;
  padding-top: 8px;
  border-top: 1px solid var(--sher-line);
  font-size: 15px;
  font-weight: 700;
}

.totals__row--grand .num {
  font-size: 22px;
  font-weight: 700;
  color: var(--sher-primary-text);
}

.totals__row--due .num {
  color: var(--sher-danger, #b91c1c);
}

.totals__row--change .num {
  color: var(--sher-ok, #047857);
}

.totals__words {
  margin: 0;
  font-size: 11px;
  color: var(--sher-text-muted);
}

/* ----------------------------------------------------------------- payment */
.pay {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.pay__row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.pay__method {
  flex: 1;
  min-width: 0;
}

.pay__amount {
  width: 8.5rem;
  flex: none;
}

.pay__links {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hint {
  margin: 0;
  font-size: 12px;
  color: var(--sher-warn-text, #b45309);
}

/* --------------------------------------------------------------- complete */
.complete {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 100%;
  padding: 12px;
  border: none;
  border-radius: var(--sher-radius-md, 10px);
  background: var(--sher-primary);
  color: var(--sher-on-primary);
  cursor: pointer;
  transition: background 120ms ease;
}

.complete:hover:not(:disabled) {
  background: var(--sher-primary-strong);
}

.complete:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.complete__en {
  font-size: 15px;
  font-weight: 700;
}

.complete__bn {
  font-size: 12px;
  opacity: 0.9;
}

.muted,
.empty {
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm, 13px);
}

.empty {
  padding: 18px 0;
  text-align: center;
}
</style>
