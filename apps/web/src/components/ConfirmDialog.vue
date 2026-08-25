<script setup lang="ts">
import { amountInWords } from '@sher/shared-utils';
import { computed } from 'vue';

import ErrorNotice from './ErrorNotice.vue';
import { taka } from './money/money-text';

/**
 * The last look before something is posted, deleted or undone (owner decision
 * 2026-08-25).
 *
 * **Money is confirmed in words, in Bangla.** A figure typed at a counter is
 * one slipped digit away from ৳45,000 instead of ৳4,500, and the two look
 * almost identical in a box. `পঁয়তাল্লিশ হাজার টাকা` and `চার হাজার পাঁচশত টাকা`
 * do not, which is exactly why a Bangladeshi cheque and a printed চালান both
 * carry the amount twice. Nothing else on this dialog is as load-bearing as
 * that line.
 *
 * One component rather than a scrim written per screen: a confirmation that
 * looks slightly different each time teaches nobody what it means, and the
 * delete dialogs already in the app share this markup.
 */
const props = defineProps<{
  title: string;
  /** The sentence under it — what will actually happen. */
  message?: string | undefined;
  /** When present, shown large with its Bangla words underneath. */
  amountMinor?: number | undefined;
  /** Extra lines: paid, due, change — whatever the decision rests on. */
  facts?: readonly { readonly label: string; readonly value: string }[] | undefined;
  confirmLabel?: string | undefined;
  confirmLabelBn?: string | undefined;
  /** A third way out: park it, rather than post it or lose it (§5.7 drafts). */
  secondaryLabel?: string | undefined;
  secondaryLabelBn?: string | undefined;
  danger?: boolean;
  busy?: boolean;
  error?: { readonly code: string; readonly message: string } | null | undefined;
}>();

const emit = defineEmits<{ confirm: []; cancel: []; secondary: [] }>();

const words = computed(() =>
  props.amountMinor === undefined ? '' : amountInWords(props.amountMinor, 'BN'),
);
</script>

<template>
  <div class="scrim" @click.self="emit('cancel')">
    <div class="dialog" role="dialog" aria-modal="true">
      <h2>{{ title }}</h2>
      <p v-if="message" class="lede">{{ message }}</p>

      <div v-if="amountMinor !== undefined" class="confirm__amount">
        <strong>{{ taka(amountMinor) }}</strong>
        <span class="confirm__words">{{ words }}</span>
      </div>

      <dl v-if="facts && facts.length > 0" class="confirm__facts">
        <div v-for="fact in facts" :key="fact.label">
          <dt>{{ fact.label }}</dt>
          <dd>{{ fact.value }}</dd>
        </div>
      </dl>

      <ErrorNotice v-if="error" :code="error.code" :message="error.message" />

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy === true" @click="emit('cancel')">
          Cancel <span class="label-bn">বাতিল</span>
        </button>
        <button
          v-if="secondaryLabel"
          type="button"
          class="btn btn-ghost"
          :disabled="busy === true"
          @click="emit('secondary')"
        >
          {{ secondaryLabel }}
          <span v-if="secondaryLabelBn" class="label-bn">{{ secondaryLabelBn }}</span>
        </button>
        <button
          type="button"
          class="btn"
          :class="danger ? 'btn-danger' : 'btn-primary'"
          :disabled="busy === true"
          @click="emit('confirm')"
        >
          {{ busy ? 'Working…' : (confirmLabel ?? 'Confirm') }}
          <span v-if="confirmLabelBn" class="label-bn on-primary">{{ confirmLabelBn }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Scrim, dialog, buttons and `.lede` come from `design/components.css`. */

/*
 * Above PrimeVue's own overlay.
 *
 * `.scrim` sits at z-index 40, which is right for a confirmation over a page —
 * but a Receive Payment or a cancellation is confirmed over a PrimeVue dialog,
 * whose mask sits at 1101. The confirmation rendered *behind* it, so the button
 * appeared to do nothing (owner-reported, 2026-08-26). A confirmation is always
 * the last thing opened, so it is always the top thing drawn.
 */
.scrim {
  z-index: 2000;
}
.confirm__amount {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  margin: 4px 0 10px;
  border-radius: var(--sher-radius-md, 10px);
  background: var(--sher-sunken);
  border: 1px solid var(--sher-line);
}

.confirm__amount strong {
  font-size: 26px;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

/* The line that catches a slipped digit. */
.confirm__words {
  font-size: 13px;
  color: var(--sher-text-muted);
}

.confirm__facts {
  margin: 0 0 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.confirm__facts > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.confirm__facts dt {
  color: var(--sher-text-muted);
}

.confirm__facts dd {
  margin: 0;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.label-bn {
  margin-left: 4px;
  font-size: 11px;
  font-weight: 400;
  opacity: 0.75;
}

.label-bn.on-primary {
  color: inherit;
  opacity: 0.9;
}
</style>
