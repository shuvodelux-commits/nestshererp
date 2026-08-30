<script setup lang="ts">
import type { SerialProgressResponse } from '@sher/core-contracts';
import { normalizeSerial } from '@sher/core-domain';
import Dialog from 'primevue/dialog';
import { computed, ref, watch } from 'vue';

import { ApiError } from '../../api/client';
import { recordSerials } from '../../api/warranty';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * Typing the numbers off the cartons (§5.19, owner decision 2026-08-26).
 *
 * **One box that takes scan after scan.** The cursor never leaves it: each scan
 * or typed number drops into the list below and the box clears for the next, so
 * a shopkeeper with a scanner in one hand and a carton in the other never has
 * to touch the screen. A counter says how many are left, and the paste box
 * covers the supplier who sends the serials in a message instead.
 *
 * SherERP never invents a serial — every value here was read off the goods.
 */
const props = defineProps<{ line: SerialProgressResponse | null }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'saved'): void }>();

const session = useSession();

const scanned = ref<string[]>([]);
const current = ref('');
const pasteMode = ref(false);
const pasted = ref('');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);

const visible = computed({
  get: () => props.line !== null,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

const outstanding = computed(() => props.line?.outstanding ?? 0);
const remaining = computed(() => Math.max(outstanding.value - scanned.value.length, 0));

watch(
  () => props.line?.purchaseLineId,
  () => {
    scanned.value = [];
    current.value = '';
    pasted.value = '';
    pasteMode.value = false;
    error.value = null;
  },
);

/**
 * Add whatever is in the box.
 *
 * A duplicate is refused here rather than at the server, because "you have
 * scanned that one already" is only useful while the shopkeeper is still
 * holding the carton.
 */
function add(): void {
  const serial = normalizeSerial(current.value);
  current.value = '';
  if (serial === '') return;

  if (scanned.value.includes(serial)) {
    error.value = { code: 'VALIDATION_FAILED', message: `${serial} is already in this list` };
    return;
  }
  if (scanned.value.length >= outstanding.value) {
    error.value = {
      code: 'VALIDATION_FAILED',
      message: 'That is already as many serials as the quantity received',
    };
    return;
  }
  error.value = null;
  scanned.value = [...scanned.value, serial];
}

function addPasted(): void {
  const serials = pasted.value
    .split(/[\n,;\t]+/u)
    .map(normalizeSerial)
    .filter((serial) => serial !== '');

  const merged = [...scanned.value];
  for (const serial of serials) {
    if (!merged.includes(serial) && merged.length < outstanding.value) merged.push(serial);
  }
  scanned.value = merged;
  pasted.value = '';
  pasteMode.value = false;
}

function drop(serial: string): void {
  scanned.value = scanned.value.filter((candidate) => candidate !== serial);
}

async function save(): Promise<void> {
  const line = props.line;
  if (line === null || scanned.value.length === 0) return;

  busy.value = true;
  error.value = null;
  try {
    await recordSerials(session.accessToken.value ?? '', {
      purchaseLineId: line.purchaseLineId,
      serials: scanned.value,
    });
    emit('saved');
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'SAVE_FAILED', message: 'The serials could not be saved. Try again.' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="Serial numbers — সিরিয়াল নম্বর"
    :style="{ width: 'min(38rem, 94vw)' }"
  >
    <form v-if="props.line !== null" class="serial-form" @submit.prevent="save">
      <p class="on-line">
        <strong>{{ props.line.displayName }}</strong>
        <span>
          {{ props.line.recorded + scanned.length }} of
          {{ props.line.recorded + outstanding }} entered · {{ remaining }} left
        </span>
      </p>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <div v-if="!pasteMode" class="field">
        <label for="serial-box">Scan or type <span class="label-bn">স্ক্যান করুন বা লিখুন</span></label>
        <input
          id="serial-box"
          v-model="current"
          autocomplete="off"
          placeholder="Scan the sticker, then the next one"
          @keydown.enter.prevent="add"
        />
        <button type="button" class="link" @click="pasteMode = true">
          Paste a list instead — তালিকা পেস্ট করুন
        </button>
      </div>

      <div v-else class="field">
        <label for="serial-paste">Paste the list <span class="label-bn">এক লাইনে একটি</span></label>
        <textarea id="serial-paste" v-model="pasted" rows="5" placeholder="One serial per line" />
        <div class="paste-actions">
          <button type="button" class="btn btn-ghost" @click="pasteMode = false">Back</button>
          <button type="button" class="btn btn-primary" @click="addPasted">Add these</button>
        </div>
      </div>

      <ul v-if="scanned.length > 0" class="chips">
        <li v-for="serial in scanned" :key="serial">
          {{ serial }}
          <button type="button" aria-label="Remove" @click="drop(serial)">×</button>
        </li>
      </ul>

      <p class="consequence">
        Units without a serial stay on the shelf but cannot be sold, so the rest can wait until
        morning.
      </p>

      <div class="dialog-actions">
        <button type="button" class="btn btn-ghost" :disabled="busy" @click="emit('close')">
          Close
        </button>
        <button type="submit" class="btn btn-primary" :disabled="busy || scanned.length === 0">
          {{ busy ? 'Saving…' : `Save ${scanned.length} serial(s)` }}
        </button>
      </div>
    </form>
  </Dialog>
</template>

<style scoped>
/*
 * The Bangla name under the English one, not trailing it (owner decision
 * 2026-08-26, pointing at the module tabs as the shape to copy).
 *
 * These labels are longer than a form's usual one or two words — "Target Stock
 * Cover কত দিনের মাল রাখবেন" on a single line wrapped mid-phrase and threw the
 * controls out of alignment. Stacked, each language reads as its own line.
 */
.field label {
  display: grid;
  gap: 1px;
  line-height: 1.3;
}

/* The 6px lead-in only makes sense when it trails the English on one line. */
.field label .label-bn {
  margin-left: 0;
}

.serial-form {
  display: grid;
  gap: var(--sher-space-3);
}

.on-line {
  margin: 0;
  display: grid;
  gap: 2px;
}

.on-line span {
  color: var(--sher-text-muted);
  font-size: 0.85rem;
}

.link {
  background: none;
  border: none;
  padding: 4px 0 0;
  color: var(--sher-primary);
  font-size: 0.8rem;
  cursor: pointer;
  text-align: left;
}

.paste-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sher-space-2);
  margin-top: var(--sher-space-2);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sher-space-2);
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 12rem;
  overflow-y: auto;
}

.chips li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  padding: 3px 10px;
  background: var(--sher-surface-2);
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}

.chips button {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--sher-text-muted);
  font-size: 1rem;
  line-height: 1;
}

.consequence {
  margin: 0;
  font-size: 0.85rem;
  color: var(--sher-text-muted);
}
</style>
