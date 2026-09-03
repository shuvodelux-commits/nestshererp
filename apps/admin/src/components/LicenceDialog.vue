<script setup lang="ts">
import { inject, ref } from 'vue';

import { api, ReauthRequired } from '../api/client';

/**
 * Issue, renew or reissue — one dialog, because they are one operation with
 * different dates (§4).
 *
 * The licence itself is signed by the isolated signer, never in the browser and
 * never in the control-plane process (§5). What this form collects is the term,
 * the modules and a reason; everything that makes the result trustworthy
 * happens on the other side of two process boundaries.
 *
 * `Delivery` is automatic when an installation is chosen and the shop is
 * enrolled. Leaving it as "hand delivery" produces a signed key to copy and
 * email — the path a shop with no line at all is renewed by, which stays open
 * deliberately.
 */
const props = defineProps<{
  tenantId: string;
  installations: { id: string; label: string; businessId: string }[];
}>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'issued'): void }>();

const requireReauth = inject<(permission: string) => Promise<void>>('requireReauth');

const MODULES = [
  'BANK_RECONCILIATION',
  'ADVANCED_REPORTS',
  'PURCHASE_PLANNING',
  'WARRANTY_SERIAL',
  'VENDOR_STOCK',
];

const installationId = ref<string>(props.installations[0]?.id ?? '');
const months = ref(12);
const modules = ref<string[]>([]);
const reason = ref('');
const replacementOf = ref('');
const error = ref('');
const busy = ref(false);

function validUntilIso(): string {
  const until = new Date();
  until.setMonth(until.getMonth() + months.value);
  until.setHours(23, 59, 59, 0);
  return until.toISOString();
}

async function issue(): Promise<void> {
  busy.value = true;
  error.value = '';
  const body = {
    tenantId: props.tenantId,
    installationId: installationId.value === '' ? null : installationId.value,
    validUntil: validUntilIso(),
    modules: modules.value,
    replacementOf: replacementOf.value === '' ? null : replacementOf.value,
    reason: reason.value,
  };
  try {
    await api('/licences', { method: 'POST', body });
    emit('issued');
  } catch (caught) {
    if (caught instanceof ReauthRequired && requireReauth !== undefined) {
      // The operator confirms with a fresh code and the same call is retried —
      // §24's step-up without losing what they had typed.
      try {
        await requireReauth('licence.issue');
        await api('/licences', { method: 'POST', body });
        emit('issued');
        return;
      } catch (retry) {
        error.value = retry instanceof Error ? retry.message : 'Could not issue';
        return;
      } finally {
        busy.value = false;
      }
    }
    error.value = caught instanceof Error ? caught.message : 'Could not issue';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="ctl-backdrop">
    <div class="ctl-modal">
      <h3>Issue or renew licence</h3>
      <div class="two-col">
        <div>
          <label class="ctl" for="l-install">Installation</label>
          <select id="l-install" v-model="installationId" class="ctl">
            <option v-for="row in installations" :key="row.id" :value="row.id">
              {{ row.label || row.id }}
            </option>
            <option value="">Hand delivery (copy the key)</option>
          </select>

          <label class="ctl" for="l-months">Term</label>
          <select id="l-months" v-model.number="months" class="ctl">
            <option :value="1">1 month (trial)</option>
            <option :value="3">3 months</option>
            <option :value="6">6 months</option>
            <option :value="12">12 months</option>
            <option :value="24">24 months</option>
          </select>

          <label class="ctl" for="l-replaces">Replaces licence (only to shorten)</label>
          <input id="l-replaces" v-model="replacementOf" class="ctl mono" placeholder="optional" />
        </div>
        <div>
          <label class="ctl">Modules</label>
          <p class="ctl-note" style="margin: 0 0 6px">
            Leave all unticked for an unrestricted licence — which is also what keeps a module built
            next year from being silently withheld from a licence issued today.
          </p>
          <label v-for="code in MODULES" :key="code" style="display: block; font-size: 12px; margin: 3px 0">
            <input v-model="modules" type="checkbox" :value="code" />
            {{ code.replace('_', ' ').toLowerCase() }}
          </label>
        </div>
      </div>

      <label class="ctl" for="l-reason">Reason (recorded in the audit trail)</label>
      <input id="l-reason" v-model="reason" class="ctl" placeholder="Annual renewal, invoice 2026-114" />

      <p v-if="error" class="ctl-error">{{ error }}</p>
      <footer>
        <button class="ctl" @click="emit('close')">Cancel</button>
        <button class="ctl primary" :disabled="busy || reason.trim().length < 3" @click="issue">
          Sign and issue
        </button>
      </footer>
    </div>
  </div>
</template>
