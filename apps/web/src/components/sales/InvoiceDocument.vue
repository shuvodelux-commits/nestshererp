<script setup lang="ts">
import type { InvoiceSettings, SaleResponse } from '@sher/core-contracts';
import { amountInWords, toBengaliDigits } from '@sher/shared-utils';
import { computed } from 'vue';

import { taka } from '../money/money-text';

/**
 * The printed invoice (§5.8), built to the owner's final artboard of
 * 2026-08-25 — **one renderer, four outputs**: the preview, the A4 sheet, the
 * 80mm receipt and the JPG that goes to WhatsApp.
 *
 * §5.8 requires the preview to use the same renderer as the final output, and
 * the reason is stronger than tidiness: a preview drawn by different code is a
 * preview that can lie about what the customer will be handed.
 *
 * **The design is the shop's, not a generic template.** A centred masthead, the
 * proprietor and phone in one black pill, three icon columns for address,
 * people and mobile money, a dotted-rule item table, the send-money numbers in
 * boxes, and `সর্বমোট` in a solid black bar. Every one of those is how this
 * trade's চালান already looks, which is why the shopkeeper recognises it.
 *
 * **Bilingual by one switch.** `settings.language` chooses the labels, and the
 * digits follow it: a Bangla sheet prints ১৭,৯৯২, while the *application* stays
 * in Western digits (UI-47).
 */

const props = defineProps<{
  sale: SaleResponse;
  settings: InvoiceSettings;
  template: 'A4' | 'THERMAL_80';
  businessName?: string | undefined;
  businessPhone?: string | undefined;
  businessAddress?: string | undefined;
  /**
   * The logo as a data URL. Not a URL to the API: an `<img src>` sends no
   * Authorization header, and a remote image would taint the canvas the JPG
   * export draws on (see `api/images.ts`).
   */
  logoDataUrl?: string | null | undefined;
}>();

const bn = computed(() => props.settings.language === 'BN');

function t(bengali: string, english: string): string {
  return bn.value ? bengali : english;
}

/** Digits follow the sheet's language, never the application's (UI-47). */
function digits(text: string): string {
  return bn.value ? toBengaliDigits(text) : text;
}

/** `৳১৭,৯৯২` — the symbol is part of the figure on this sheet, with no gap. */
function money(minor: number): string {
  return digits(taka(minor));
}

function qty(raw: number): string {
  return digits(String(Math.round(raw) / 1000));
}

const MONTHS_BN = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর',
] as const;
const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

function longDate(date: string | null): string {
  if (date === null) return '—';
  const [year, month, day] = date.split('-');
  const name = (bn.value ? MONTHS_BN : MONTHS_EN)[Number(month) - 1] ?? '';
  return digits(`${day ?? ''} ${name} ${year ?? ''}`);
}

const presentation = computed(() => props.sale.presentation);
const customerName = computed(
  () => presentation.value?.customerDisplayName ?? props.sale.customerName,
);
const customerPhone = computed(() => presentation.value?.customerPhone ?? props.sale.customerPhone);
const customerAddress = computed(
  () => presentation.value?.customerAddress ?? props.sale.customerAddress,
);
const guardianName = computed(
  () => presentation.value?.customerGuardianName ?? props.sale.customerGuardianName,
);

function lineName(id: string, fallback: string): string {
  return presentation.value?.lineNames.find((line) => line.saleLineId === id)?.displayName ?? fallback;
}

const shopName = computed(() => props.settings.businessName ?? props.businessName ?? 'SherERP');

/**
 * The address prints exactly as it was typed — one printed line per typed line.
 *
 * It used to break on commas too, which turned `চাঁচকৈর বাজার, চৈতালি হাটা মোড়`
 * into four stacked fragments instead of the two lines the shop wanted
 * (owner-reported, 2026-08-25). Where a line ends is a design decision, and it
 * belongs to whoever types the address, not to this component.
 */
/** The bar carries the address as one line; typed breaks become separators. */
const addressLine = computed(() =>
  addressLines.value.map((line) => line.replace(/,+$/, '')).join(', '),
);

const addressLines = computed(() =>
  (props.settings.businessAddress ?? props.businessAddress ?? '')
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part !== ''),
);

const phones = computed(() => {
  const listed = props.settings.contactPhones.filter((phone) => phone.number.trim() !== '');
  if (listed.length > 0) return listed;
  const fallback = props.settings.businessPhone ?? props.businessPhone;
  return fallback === null || fallback === undefined || fallback === ''
    ? []
    : [{ label: '', number: fallback }];
});

const words = computed(() => amountInWords(props.sale.grandTotalMinor, bn.value ? 'BN' : 'EN'));

const extras = computed(() =>
  [
    { label: presentation.value?.customLabel1, value: presentation.value?.customValue1 },
    { label: presentation.value?.customLabel2, value: presentation.value?.customValue2 },
    { label: presentation.value?.customLabel3, value: presentation.value?.customValue3 },
  ].filter((row) => row.value !== null && row.value !== undefined && row.value !== ''),
);
</script>

<template>
  <article
    class="inv"
    :class="[`inv--${template.toLowerCase()}`, { 'inv--bn': bn }]"
    :style="{
      paddingTop: `${String(
        settings.businessPadEnabled ? settings.businessPadTopMm : settings.pageMarginMm,
      )}mm`,
      paddingLeft: `${String(settings.pageMarginMm)}mm`,
      paddingRight: `${String(settings.pageMarginMm)}mm`,
      paddingBottom: '0',
    }"
  >
    <!-- ------------------------------------------------- centred masthead -->
    <header v-if="!settings.businessPadEnabled" class="mast">
      <p v-if="settings.showHeaderText && settings.headerText" class="mast__opening">
        {{ settings.headerText }}
      </p>

      <img v-if="logoDataUrl && settings.showLogo" :src="logoDataUrl" class="mast__logo" alt="" />

      <h1 class="mast__name">{{ shopName }}</h1>

      <!-- The proprietor and the shop's own number, in one solid pill. -->
      <p v-if="settings.proprietorName" class="mast__pill">{{ settings.proprietorName }}</p>

      <p v-if="settings.proprietorNote" class="mast__note">{{ settings.proprietorNote }}</p>
      <p v-if="settings.businessDescription" class="mast__about">
        {{ settings.businessDescription }}
      </p>

      <!--
        Address and the people who answer the phone, in one black bar across the
        sheet (owner design 2026-08-25). One row rather than two icon columns:
        it is the line a customer looks at to find the shop, and it reads as one
        fact, not three stacked ones.
      -->
      <div v-if="addressLine || phones.length > 0" class="mast__bar">
        <span v-if="addressLine" class="mast__bar-item">
          <svg class="mast__bar-icon" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5Z"/>
          </svg>
          {{ addressLine }}
        </span>
        <span v-for="phone in phones" :key="phone.number" class="mast__bar-item">
          <template v-if="phone.label">{{ phone.label }} - </template>{{ digits(phone.number) }}
        </span>
      </div>
    </header>

    <!-- ------------------------------------------- who, and which document -->
    <section class="parties">
      <div class="parties__col">
        <p><b>{{ t('নামঃ', 'Name:') }}</b> {{ customerName }}</p>
        <p v-if="customerPhone">
          <b>{{ t('মোবাইলঃ', 'Mobile:') }}</b> {{ digits(customerPhone) }}
        </p>
      </div>
      <div class="parties__col">
        <p v-if="guardianName">
          <b>{{ t('পিতাঃ', 'Father:') }}</b> {{ guardianName }}
        </p>
        <p v-if="customerAddress"><b>{{ t('ঠিকানাঃ', 'Address:') }}</b> {{ customerAddress }}</p>
      </div>
      <dl class="parties__doc">
        <div>
          <dt>{{ t('চালান নংঃ', 'Invoice no:') }}</dt>
          <dd>{{ digits(sale.number) }}</dd>
        </div>
        <div>
          <dt>{{ t('তারিখঃ', 'Date:') }}</dt>
          <dd>{{ longDate(sale.businessDate) }}</dd>
        </div>
        <div v-if="sale.dueDate">
          <dt>{{ t('শেষ তারিখঃ', 'Due date:') }}</dt>
          <dd>{{ longDate(sale.dueDate) }}</dd>
        </div>
      </dl>
    </section>

    <!-- ------------------------------------------------------------ items -->
    <table class="items">
      <thead>
        <tr>
          <th class="w-no">{{ t('নং', 'No') }}</th>
          <th class="w-name">{{ t('পণ্যের নাম', 'Description') }}</th>
          <th class="w-qty">{{ t('পরিমান', 'Qty') }}</th>
          <th class="w-unit">{{ t('একক', 'Unit') }}</th>
          <th class="w-rate">{{ t('দর', 'Rate') }}</th>
          <th class="w-amt">{{ t('টাকা', 'Amount') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(line, index) in sale.lines" :key="line.id">
          <td class="w-no">{{ digits(String(index + 1)) }}</td>
          <td class="w-name">{{ lineName(line.id, line.productName) }}</td>
          <td class="w-qty">{{ qty(line.qty) }}</td>
          <td class="w-unit">{{ line.unitName }}</td>
          <td class="w-rate">{{ money(line.unitPriceMinor) }}</td>
          <td class="w-amt">{{ money(line.netAmountMinor) }}</td>
        </tr>
      </tbody>
    </table>

    <!-- --------------------------------------- money in, and what it adds to -->
    <section class="close">
      <div class="close__left">
        <template v-if="settings.showPaymentBreakdown && settings.mfsNumbers.length > 0">
          <p class="close__label">{{ t('সেন্ড মানি', 'Send money') }}</p>
          <div class="sendmoney">
            <span v-for="entry in settings.mfsNumbers" :key="entry.number">
              {{ entry.label }} {{ digits(entry.number) }}
            </span>
          </div>
        </template>

        <p v-for="payment in sale.payments" :key="payment.id" class="close__paid">
          {{ payment.accountName }} — {{ money(payment.amountMinor) }} {{ t('টাকা', '') }}
          ( {{ longDate(sale.businessDate) }} )
        </p>
        <p v-for="receipt in sale.receipts" :key="receipt.id" class="close__paid">
          {{ receipt.accountName }} — {{ money(receipt.amountMinor) }} {{ t('টাকা', '') }}
          ( {{ longDate(receipt.businessDate) }} )
        </p>
        <p v-if="presentation?.paymentNote" class="close__paid">{{ presentation.paymentNote }}</p>

        <ul v-if="settings.terms.length > 0 || settings.termsText" class="terms">
          <li v-for="(term, index) in settings.terms" :key="index">{{ term }}</li>
          <li v-if="settings.termsText">{{ settings.termsText }}</li>
        </ul>

        <p v-if="presentation?.deliveryAddress" class="close__paid">
          {{ t('ডেলিভারি', 'Deliver to') }}: {{ presentation.deliveryAddress }}
        </p>
        <p v-if="presentation?.courierName" class="close__paid">
          {{ t('কুরিয়ার', 'Courier') }}: {{ presentation.courierName }}
        </p>
        <p v-if="presentation?.deliveryInstruction" class="close__paid">
          {{ presentation.deliveryInstruction }}
        </p>
        <p v-for="extra in extras" :key="extra.label ?? ''" class="close__paid">
          <b v-if="extra.label">{{ extra.label }}: </b>{{ extra.value }}
        </p>
      </div>

      <div class="totals">
        <div class="totals__row">
          <span>{{ t('সাব-টোটাল', 'Subtotal') }}</span>
          <b>{{ money(sale.itemsTotalMinor) }}</b>
        </div>
        <div v-if="settings.showDiscount && sale.discountMinor > 0" class="totals__row">
          <span>{{ t('ডিস্কাউন্ট', 'Discount') }}</span>
          <b>{{ money(sale.discountMinor) }}</b>
        </div>
        <div class="totals__row totals__row--grand">
          <span>{{ t('সর্বমোট', 'Grand Total') }}</span>
          <b>{{ money(sale.grandTotalMinor) }}</b>
        </div>
        <div v-if="sale.paidMinor > 0" class="totals__row">
          <span>{{ t('পরিশোধ', 'Paid') }}</span>
          <b>{{ money(sale.paidMinor) }}</b>
        </div>
        <div v-if="settings.showDue && sale.dueMinor > 0" class="totals__row">
          <span>{{ t('বকেয়া', 'Due') }}</span>
          <b>{{ money(sale.dueMinor) }}</b>
        </div>
        <p v-if="settings.showAmountInWords" class="totals__words">
          {{ t('কথায়ঃ', 'In words:') }} {{ words }}
        </p>
      </div>
    </section>

    <p v-if="sale.status === 'VOIDED'" class="voided">{{ t('বাতিল', 'CANCELLED') }}</p>

    <!-- --------------------------------------------------------- signatures -->
    <footer v-if="settings.showSignatureLines" class="signs">
      <span class="signs__one">{{ t('ক্রেতার স্বাক্ষর', 'Customer signature') }}</span>
      <span class="signs__one signs__one--right">
        <b>{{ shopName }}</b>
        <em>{{ t('প্রতিষ্ঠানের পক্ষে', 'For the shop') }}</em>
      </span>
    </footer>

    <p v-if="settings.footerText" class="thanks">{{ settings.footerText }}</p>
  </article>
</template>

<style scoped>
/*
 * Black on white, one weight of rule, no colour: this sheet is photocopied,
 * printed on a thermal roll and photographed for WhatsApp, and anything that
 * depends on colour survives none of the three.
 */
.inv {
  display: flex;
  flex-direction: column;
  /* A4 minus the sheet's own margins, so the footer can sit at the bottom. */
  min-height: 267mm;
  background: #fff;
  color: #000;
  font-size: 13px;
  line-height: 1.5;
  width: 100%;
}

/*
 * Browsers drop background colours when printing unless asked not to — which is
 * how the proprietor pill and the সর্বমোট bar came out as outlines with grey
 * text on paper (owner-reported, 2026-08-25). These two blocks *are* the
 * design's only filled elements, so the sheet asks explicitly.
 */
.inv,
.inv * {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.inv--bn {
  font-family: var(--sher-font-bn, 'Noto Sans Bengali', 'Nirmala UI', sans-serif);
}

.inv--a4 {
  max-width: 210mm;
}

.inv--thermal_80 {
  max-width: 80mm;
  font-size: 10px;
}

/* ------------------------------------------------------------- masthead */
.mast {
  text-align: center;
  padding-bottom: 10px;
}

.mast__opening {
  margin: 0 0 2px;
  font-size: 13px;
}

/*
 * The logo prints at one standard size whatever picture is uploaded: 110px tall
 * (about 29mm on A4), never wider than 60mm. Height alone left a wide logo
 * looking small beside the shop name, because a 4:1 banner scaled to 74px tall
 * is a thin strip; the box is fixed and `contain` fits the picture inside it,
 * so a square mark and a wide banner both come out at the same visual weight.
 */
.mast__logo {
  height: 110px;
  max-width: 60mm;
  width: auto;
  margin-bottom: 8px;
  object-fit: contain;
}

/* The shop's name is the loudest thing on the page, by a long way. */
.mast__name {
  margin: 0;
  font-size: 34px;
  font-weight: 800;
  line-height: 1.15;
  letter-spacing: -0.01em;
}

/* Proprietor and phone in one solid pill — the shop's own signature mark. */
.mast__pill {
  display: inline-flex;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  align-items: center;
  gap: 8px;
  margin: 8px 0 0;
  padding: 4px 18px;
  border-radius: 999px;
  background: #000;
  color: #fff;
  font-size: 14px;
  font-weight: 700;
}

/*
 * Every Enter the shopkeeper types is a line break on the invoice, and runs of
 * spaces still collapse (owner decision 2026-08-25). Where a line ends in an
 * address or a description is a design decision, and it belongs to whoever
 * writes it — not to a renderer guessing at commas.
 */
.mast__note,
.mast__about,
.mast__bar-item,
.thanks,
.terms li {
  white-space: pre-line;
}

.mast__note {
  margin: 6px 0 0;
  font-size: 13px;
}

.mast__about {
  margin: 8px auto 0;
  max-width: 125mm;
  font-size: 14.5px;
  font-weight: 600;
}

/*
 * One black bar, full width, rounded like the proprietor pill above it — the
 * two filled shapes are what give this sheet its face. Print asks explicitly
 * for the fill, because browsers drop backgrounds on paper by default.
 */
.mast__bar {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: nowrap;
  gap: 0;
  margin-top: 12px;
  padding: 0 0 8px;
  color: #000;
  font-size: 12.5px;
  font-weight: 700;
  white-space: nowrap;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

.mast__bar-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 0 9px;
}

.mast__bar-item + .mast__bar-item {
  border-left: 1.2px solid #000;
}

.mast__bar-icon {
  width: 15px;
  height: 15px;
  fill: #000;
  flex: none;
}

/* ------------------------------------------------- customer and document */
/*
 * Two lines tall, and the rule sits directly under them.
 *
 * `চালান নংঃ` was wrapping onto a second line inside its own cell, which made
 * the block taller than its text and left a gap between the party details and
 * the rule beneath (owner-reported, 2026-08-25). The labels do not wrap; the
 * values do.
 */
.parties {
  display: flex;
  gap: 16px;
  padding: 8px 0;
  border-top: 1px solid #000;
  border-bottom: 1px solid #000;
}

.parties__col {
  flex: 1;
  min-width: 0;
}

.parties__col p,
.parties__doc dt,
.parties__doc dd {
  margin: 0;
  font-size: 13px;
}

.parties__doc {
  flex: 1.15;
  margin: 0;
  min-width: 0;
}

.parties__doc dt {
  white-space: nowrap;
}

.parties__doc dd {
  text-align: right;
  white-space: nowrap;
}

/* Label left, value hard right — the shape a printed pad already has. */
.parties__doc > div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

/* ------------------------------------------------------------- the items */
.items {
  width: 100%;
  border-collapse: collapse;
  margin-top: 0;
}

.items thead th {
  padding: 10px 8px;
  font-size: 14px;
  font-weight: 700;
  border-bottom: 1px solid #000;
  text-align: center;
}

.items thead th.w-name {
  text-align: center;
}

/* Dotted rules between rows and columns: lighter than the frame around them,
 * so the eye reads the numbers and not the grid. */
.items tbody td {
  padding: 11px 8px;
  border-bottom: 1px dotted #9a9a9a;
  text-align: center;
  font-size: 14px;
}

.items th + th,
.items td + td {
  border-left: 1px dotted #9a9a9a;
}

.items tbody tr:last-child td {
  border-bottom: 1px solid #000;
}

.w-no {
  width: 6%;
}

.w-name {
  width: 38%;
  text-align: left !important;
}

.w-qty,
.w-unit {
  width: 12%;
}

.w-rate,
.w-amt {
  width: 16%;
}

/* ------------------------------------------- payment, terms and the sums */
.close {
  display: flex;
  gap: 28px;
  margin-top: 18px;
}

.close__left {
  flex: 1;
  min-width: 0;
}

.close__label {
  margin: 0 0 6px;
  font-size: 12px;
}

.sendmoney {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.sendmoney span {
  border: 1px solid #000;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 600;
}

.close__paid {
  margin: 0 0 2px;
  font-size: 13px;
}

.terms {
  margin: 10px 0 0;
  padding-left: 18px;
  font-size: 13px;
}

.terms li {
  margin-bottom: 2px;
}

.totals {
  width: 46%;
  flex: none;
}

.totals__row {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  padding: 8px 2px;
  border-bottom: 1px solid #000;
  font-size: 16px;
  font-weight: 600;
}

/* The black bar carries its own edge, so the row above it drops its rule —
 * a hairline touching a solid block reads as a printing fault. */
.totals__row:has(+ .totals__row--grand) {
  border-bottom: none;
}

/* The figure everybody looks for first, and the only filled block down here. */
.totals__row--grand {
  background: #000 !important;
  color: #fff !important;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
  border-bottom: none;
  padding: 10px 12px;
  margin: 0 0 2px;
  font-size: 18px;
  font-weight: 800;
}

.totals__words {
  margin: 10px 0 0;
  text-align: right;
  font-size: 14px;
}

.voided {
  margin: 12px 0 0;
  text-align: center;
  font-weight: 700;
  letter-spacing: 0.2em;
}

/* --------------------------------------------------------- signatures */
.signs {
  display: flex;
  justify-content: space-between;
  gap: 60px;
  /* Everything unused on a short invoice collects here. */
  margin-top: auto;
  padding-top: 60px;
}

.signs__one {
  flex: 1;
  border-top: 1px solid #000;
  padding-top: 4px;
  font-size: 12.5px;
}

.signs__one--right {
  text-align: right;
  display: flex;
  flex-direction: column;
}

.signs__one em {
  font-style: normal;
}

.thanks {
  margin: 10px 0 0;
  padding-bottom: 2px;
  text-align: center;
  font-size: 12.5px;
}

/* A thermal roll is one narrow column: the three-up blocks stack and the
 * dotted column rules come off, because 80mm cannot hold six of them. */
.inv--thermal_80 .mast__bar,
.inv--thermal_80 .parties,
.inv--thermal_80 .close,
.inv--thermal_80 .signs {
  flex-direction: column;
  gap: 6px;
}

.inv--thermal_80 .mast__bar {
  border-radius: 0;
  padding: 4px 6px;
  font-size: 10px;
  flex-wrap: wrap;
  white-space: normal;
}

.inv--thermal_80 .mast__bar-item + .mast__bar-item {
  border-left: none;
}

.inv--thermal_80 .mast__name {
  font-size: 18px;
}

/* 80mm of paper cannot carry the A4 mark; same shape, smaller. */
.inv--thermal_80 .mast__logo {
  height: 56px;
}

.inv--thermal_80 .totals {
  width: 100%;
}

.inv--thermal_80 .items th + th,
.inv--thermal_80 .items td + td {
  border-left: none;
}

.inv--thermal_80 .items thead th,
.inv--thermal_80 .items tbody td {
  padding: 4px 2px;
  font-size: 10px;
}

.inv--thermal_80 .signs {
  margin-top: 30px;
}
</style>
