<script setup lang="ts">
import type { DaybookPrint, DaybookResponse } from '@sher/core-contracts';

import { taka } from '../money/money-text';

/**
 * The printed day-end report (§5.27), on A4 and on the 80mm counter roll.
 *
 * One renderer for both, the way the invoice does it: the layout is the same
 * document at two widths, so a figure can never appear on one and not the
 * other. It prints through the global print stylesheet — the page already
 * holds every number, and rendering it a second time somewhere else is how the
 * paper and the screen start to disagree.
 *
 * The sections are §5.27's, in its order, and the **backdated section is not
 * optional**: without it a printed day can be silently invalidated by an entry
 * somebody types tomorrow against today.
 */
defineProps<{
  daybook: DaybookResponse;
  print: DaybookPrint | null;
  businessName: string;
  format: 'A4' | 'THERMAL_80';
}>();
</script>

<template>
  <article class="sheet" :class="format === 'A4' ? 'sheet--a4' : 'sheet--roll'">
    <header class="sheet__head">
      <h1>{{ businessName }}</h1>
      <p class="sheet__title">Day-end report — দিনের হিসাব</p>
      <p class="sheet__meta">
        {{ daybook.from }} → {{ daybook.to }}
        <span v-if="print !== null">· print #{{ print.printSerial }} · {{ print.printedByName }}</span>
      </p>
      <p v-if="print !== null && print.isReprint" class="sheet__reprint">REPRINT</p>
    </header>

    <section v-for="day in daybook.days" :key="day.businessDate" class="sheet__day">
      <h2>{{ day.businessDate }}</h2>

      <table class="sheet__state">
        <tbody>
          <tr><td>Opening cash — শুরুর ক্যাশ</td><td class="num">{{ taka(day.openingCashMinor) }}</td></tr>
          <tr><td>Cash in — জমা</td><td class="num">{{ taka(day.cashInMinor) }}</td></tr>
          <tr><td>Cash out — খরচ</td><td class="num">{{ taka(day.cashOutMinor) }}</td></tr>
          <tr><td>Expected — থাকার কথা</td><td class="num">{{ taka(day.expectedClosingMinor) }}</td></tr>
          <tr v-if="day.countedMinor !== null"><td>Counted — গোনা হয়েছে</td><td class="num">{{ taka(day.countedMinor) }}</td></tr>
          <tr v-if="day.differenceMinor !== null" class="sheet__diff">
            <td>Difference — পার্থক্য</td>
            <td class="num">{{ taka(day.differenceMinor) }}</td>
          </tr>
        </tbody>
      </table>

      <table class="sheet__totals">
        <tbody>
          <tr><td>Sales — বিক্রি</td><td class="num">{{ taka(day.salesMinor) }}</td></tr>
          <tr><td>Purchases — কেনা</td><td class="num">{{ taka(day.purchasesMinor) }}</td></tr>
          <tr><td>Money received — টাকা এসেছে</td><td class="num">{{ taka(day.receiptsMinor) }}</td></tr>
          <tr><td>Money paid — টাকা দেওয়া</td><td class="num">{{ taka(day.paymentsMinor) }}</td></tr>
          <tr><td>Expenses — খরচ</td><td class="num">{{ taka(day.expensesMinor) }}</td></tr>
          <tr><td>Returns — ফেরত</td><td class="num">{{ taka(day.returnsMinor) }}</td></tr>
        </tbody>
      </table>

      <table class="sheet__rows">
        <thead>
          <tr>
            <th>Time</th>
            <th>What happened</th>
            <th>Who</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in daybook.rows.filter((entry) => entry.businessDate === day.businessDate)"
            :key="row.id"
            :class="row.status === 'VOIDED' ? 'is-void' : ''"
          >
            <td>{{ row.createdAt.slice(11, 16) }}</td>
            <td>{{ row.description }}</td>
            <td>{{ row.partyName ?? row.createdByName }}</td>
            <td class="num">{{ taka(row.amountMinor) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- DR7: without this, a printed day can be invalidated in silence. -->
    <section v-if="daybook.backdatedRows.length > 0" class="sheet__backdated">
      <h2>Entered late or dated elsewhere — পরে বসানো এন্ট্রি</h2>
      <table class="sheet__rows">
        <tbody>
          <tr v-for="row in daybook.backdatedRows" :key="row.id">
            <td>{{ row.businessDate }}</td>
            <td>{{ row.description }}</td>
            <td>typed {{ row.createdAt.slice(0, 10) }}</td>
            <td class="num">{{ taka(row.amountMinor) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="sheet__foot">
      <div class="sheet__signs">
        <span>Counted by — গুনেছেন</span>
        <span>Checked by — মিলিয়েছেন</span>
      </div>
    </footer>
  </article>
</template>

<style scoped>
.sheet { background: #fff; color: #0f172a; padding: 1.25rem; font-size: 0.85rem; }
.sheet--a4 { width: 100%; max-width: 210mm; margin: 0 auto; }
.sheet--roll { width: 80mm; margin: 0 auto; font-size: 0.72rem; }
.sheet__head { text-align: center; border-bottom: 1px solid #cbd5e1; padding-bottom: 0.5rem; }
.sheet__head h1 { margin: 0; font-size: 1.1rem; }
.sheet__title { margin: 0.15rem 0 0; font-weight: 600; }
.sheet__meta { margin: 0.15rem 0 0; color: #475569; font-size: 0.75rem; }
.sheet__reprint { margin: 0.3rem 0 0; font-weight: 800; letter-spacing: 0.2em; color: #b91c1c; }
.sheet__day { margin-top: 0.9rem; }
.sheet__day h2 { font-size: 0.95rem; margin: 0 0 0.35rem; border-bottom: 1px solid #e2e8f0; }
table { width: 100%; border-collapse: collapse; margin-bottom: 0.5rem; }
th, td { padding: 0.2rem 0.3rem; text-align: left; }
.sheet__rows th { border-bottom: 1px solid #cbd5e1; font-size: 0.75rem; }
.sheet__rows td { border-bottom: 1px dotted #e2e8f0; }
.num { text-align: right; }
.is-void { text-decoration: line-through; color: #94a3b8; }
.sheet__diff td { font-weight: 700; }
.sheet__backdated { margin-top: 1rem; border-top: 1px solid #cbd5e1; padding-top: 0.5rem; }
.sheet__foot { margin-top: 1.5rem; }
.sheet__signs { display: flex; justify-content: space-between; gap: 2rem; }
.sheet__signs span { border-top: 1px solid #94a3b8; padding-top: 0.25rem; flex: 1; text-align: center; font-size: 0.75rem; }
</style>
