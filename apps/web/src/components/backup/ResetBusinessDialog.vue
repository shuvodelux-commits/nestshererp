<script setup lang="ts">
import { RESET_CONFIRMATION_PHRASE } from '@sher/core-contracts';
import Dialog from 'primevue/dialog';
import { computed, ref, watch } from 'vue';

import { resetBusiness } from '../../api/backup';
import { ApiError } from '../../api/client';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * Emptying this installation (Phase 10, owner decisions 2026-08-30).
 *
 * The most destructive thing in SherERP. It is reached only from the foot of
 * the Backup page — never from a menu — so the person about to press it has
 * just been shown when the last good backup was taken, and that date is shown
 * again here.
 *
 * Three things are asked for: the permission (server-side), the password again,
 * and the phrase typed out in full. Before a single row is deleted the server
 * takes a PostgreSQL recovery copy **and verifies it can be read back**; if it
 * cannot, nothing is cleared.
 */
const props = defineProps<{ open: boolean; lastBackupAt: string | null }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'reset'): void }>();

const session = useSession();

const visible = computed({
  get: () => props.open,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

const confirmPassword = ref('');
const confirmPhrase = ref('');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const done = ref<{ path: string; rows: number } | null>(null);

watch(
  () => props.open,
  (open) => {
    if (open) return;
    confirmPassword.value = '';
    confirmPhrase.value = '';
    error.value = null;
    done.value = null;
  },
);

const phrase = RESET_CONFIRMATION_PHRASE;
const canReset = computed(
  () => !busy.value && confirmPassword.value !== '' && confirmPhrase.value.trim() === phrase,
);

const lastBackupText = computed(() =>
  props.lastBackupAt === null
    ? null
    : new Date(props.lastBackupAt).toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
);

async function run(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !canReset.value) return;

  busy.value = true;
  error.value = null;
  try {
    const result = await resetBusiness(token, confirmPassword.value, confirmPhrase.value);
    done.value = { path: result.recoveryDumpPath, rows: result.rowsCleared };
    emit('reset');
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'The business data was not cleared.' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="Reset business data — সব হিসাব মুছে ফেলুন"
    :style="{ width: 'min(38rem, 94vw)' }"
  >
    <div v-if="done !== null" class="reset">
      <p class="reset__done">
        Cleared {{ done.rows.toLocaleString('en-GB') }} rows. A recovery copy of the database was
        made first and is kept at <code>{{ done.path }}</code>.
      </p>
      <footer class="reset__footer">
        <button type="button" class="btn-primary" @click="emit('close')">Close</button>
      </footer>
    </div>

    <form v-else class="reset" @submit.prevent="run">
      <p class="reset__warn">
        <strong>This deletes every product, party, bill, invoice, payment and ledger entry in this
        installation.</strong>
        Your users, roles and this shop's account stay. It cannot be undone from inside SherERP.
        <span class="label-bn">এটা ফেরানো যাবে না।</span>
      </p>

      <p class="reset__note">
        Before anything is deleted, SherERP makes a recovery copy of the database and checks it can
        be read back. If that check fails, nothing is cleared.
      </p>

      <p class="reset__last">
        <template v-if="lastBackupText !== null">
          Last backup downloaded from this computer: <strong>{{ lastBackupText }}</strong>
        </template>
        <template v-else>
          <strong>No backup has ever been downloaded from this computer.</strong>
          Download one first if this data still matters.
        </template>
      </p>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <div class="field">
        <label for="reset-phrase">
          Type <code>{{ phrase }}</code> to confirm
          <span class="label-bn">নিশ্চিত করতে লিখুন</span>
        </label>
        <input
          id="reset-phrase"
          v-model="confirmPhrase"
          autocomplete="off"
          spellcheck="false"
          :placeholder="phrase"
        />
      </div>

      <div class="field">
        <label for="reset-password">Your own password <span class="label-bn">আপনার পাসওয়ার্ড</span></label>
        <input
          id="reset-password"
          v-model="confirmPassword"
          type="password"
          autocomplete="current-password"
          placeholder="The password you sign in with"
        />
      </div>

      <footer class="reset__footer">
        <button type="button" class="btn-ghost" @click="emit('close')">Cancel</button>
        <button type="submit" class="btn-danger" :disabled="!canReset">
          {{ busy ? 'Clearing…' : 'Delete all business data' }}
        </button>
      </footer>
    </form>
  </Dialog>
</template>

<style scoped>
.reset {
  display: grid;
  gap: 0.9rem;
}

.reset__warn,
.reset__note,
.reset__last,
.reset__done {
  margin: 0;
  line-height: 1.5;
}

.reset__warn {
  padding: 0.75rem 0.85rem;
  border-radius: var(--sher-radius-sm, 6px);
  background: var(--sher-danger-soft, #fee2e2);
  color: var(--sher-danger-ink, #7f1d1d);
}

.reset__note,
.reset__last {
  color: var(--sher-ink-muted, #52525b);
}

.reset__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
</style>
