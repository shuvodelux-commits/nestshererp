<script setup lang="ts">
import Dialog from 'primevue/dialog';
import { computed, ref, watch } from 'vue';

import { replaceBackupSecret } from '../../api/backup';
import { ApiError } from '../../api/client';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * Set or replace the backup password (Phase 10, D-15).
 *
 * **The current password is never shown here, because it is never sent here.**
 * It lives in a key file outside the database and no route returns it. This
 * dialog can set a new one and nothing else.
 *
 * The warning is the important part of the screen: every archive already
 * written stays encrypted under the **previous** password. Saying that after
 * the fact would be telling a shop its fourteen backups became unreadable an
 * hour ago.
 */
const props = defineProps<{ open: boolean; alreadySet: boolean }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'saved'): void }>();

const session = useSession();

const visible = computed({
  get: () => props.open,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

const confirmPassword = ref('');
const newSecret = ref('');
const repeatSecret = ref('');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    confirmPassword.value = '';
    newSecret.value = '';
    repeatSecret.value = '';
    error.value = null;
  },
);

const mismatch = computed(
  () => repeatSecret.value !== '' && repeatSecret.value !== newSecret.value,
);
const tooShort = computed(() => newSecret.value !== '' && newSecret.value.length < 12);
const canSave = computed(
  () =>
    !busy.value &&
    confirmPassword.value !== '' &&
    newSecret.value.length >= 12 &&
    repeatSecret.value === newSecret.value,
);

async function save(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !canSave.value) return;

  busy.value = true;
  error.value = null;
  try {
    await replaceBackupSecret(token, confirmPassword.value, newSecret.value);
    emit('saved');
    emit('close');
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? { code: cause.code, message: cause.message }
        : { code: 'UNKNOWN', message: 'The backup password could not be saved.' };
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    :header="alreadySet ? 'Change backup password — ব্যাকআপের পাসওয়ার্ড বদলান' : 'Set backup password — ব্যাকআপের পাসওয়ার্ড দিন'"
    :style="{ width: 'min(38rem, 94vw)' }"
  >
    <form class="secret-form" @submit.prevent="save">
      <p class="secret-form__warn">
        <strong>Write this password down and keep it somewhere safe.</strong>
        SherERP does not store a copy anywhere it can show you, and there is no way to recover it.
        Without it, no backup file can ever be opened again.
        <span class="secret-form__bn">এই পাসওয়ার্ড হারালে ব্যাকআপ ফাইল আর কোনোদিন খোলা যাবে না।</span>
      </p>

      <p v-if="alreadySet" class="secret-form__warn secret-form__warn--old">
        Backups already taken stay locked with the <strong>old</strong> password. Keep the old one
        as well, or those files cannot be opened.
      </p>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <div class="secret-form__grid">
        <div class="field">
          <label for="secret-new">New backup password <span class="label-bn">নতুন পাসওয়ার্ড</span></label>
          <input
            id="secret-new"
            v-model="newSecret"
            type="password"
            autocomplete="new-password"
            placeholder="At least 12 characters"
          />
          <p v-if="tooShort" class="field__hint field__hint--bad">
            Use at least 12 characters.
          </p>
        </div>

        <div class="field">
          <label for="secret-repeat">Type it again <span class="label-bn">আবার লিখুন</span></label>
          <input
            id="secret-repeat"
            v-model="repeatSecret"
            type="password"
            autocomplete="new-password"
            placeholder="The same password again"
          />
          <p v-if="mismatch" class="field__hint field__hint--bad">
            The two do not match.
          </p>
        </div>

        <div class="field secret-form__wide">
          <label for="secret-confirm">Your own password <span class="label-bn">আপনার পাসওয়ার্ড</span></label>
          <input
            id="secret-confirm"
            v-model="confirmPassword"
            type="password"
            autocomplete="current-password"
            placeholder="The password you sign in with"
          />
          <p class="field__hint">Asked again because this changes how every backup is locked.</p>
        </div>
      </div>

      <footer class="secret-form__footer">
        <button type="button" class="btn-ghost" @click="emit('close')">Cancel</button>
        <button type="submit" class="btn-primary" :disabled="!canSave">
          {{ busy ? 'Saving…' : alreadySet ? 'Change password' : 'Set password' }}
        </button>
      </footer>
    </form>
  </Dialog>
</template>

<style scoped>
.field__hint {
  margin: 0.3rem 0 0;
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
  line-height: 1.45;
}

.secret-form {
  display: grid;
  gap: 1rem;
}

.secret-form__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.75rem 1rem;
}

.secret-form__wide {
  grid-column: 1 / -1;
}

.secret-form__warn {
  margin: 0;
  padding: 0.75rem 0.85rem;
  border-radius: var(--sher-radius-sm, 6px);
  background: var(--sher-warning-soft, #fff6e5);
  color: var(--sher-warning-ink, #6b4a00);
  line-height: 1.5;
}

.secret-form__warn--old {
  background: var(--sher-surface-muted, #f4f4f5);
  color: var(--sher-ink-muted, #52525b);
}

.secret-form__bn {
  display: block;
  margin-top: 0.35rem;
  font-size: 0.85em;
}

.secret-form__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

.field__hint--bad {
  color: var(--sher-danger, #b91c1c);
}

@media (max-width: 34rem) {
  .secret-form__grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
