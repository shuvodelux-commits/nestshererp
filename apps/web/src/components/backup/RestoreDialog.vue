<script setup lang="ts">
import type { ArchivePreviewResponse } from '@sher/core-contracts';
import Dialog from 'primevue/dialog';
import { computed, ref, watch } from 'vue';

import { inspectArchive, restoreArchive } from '../../api/backup';
import { ApiError } from '../../api/client';
import { useSession } from '../../auth/session';
import ErrorNotice from '../ErrorNotice.vue';

/**
 * Restoring a backup (Phase 10, §5.25, owner decisions 2026-08-30).
 *
 * Two steps, and the first one writes nothing: choose the file, and the server
 * reads it and says what is inside — which business, taken when, by which
 * version, and how many of each thing. **Nothing is written until that has been
 * read and confirmed.**
 *
 * The file comes from wherever the person doing the recovery has it: a pen
 * drive, an external disk, their own computer, a network share, a download from
 * cloud storage. It is streamed and validated before any business data is
 * touched.
 *
 * When it succeeds, this installation becomes the business in the file — its
 * users, its passwords, its roles — and the temporary recovery account is gone.
 * The session ends, and the operator signs in as themselves.
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (event: 'close'): void; (event: 'restored'): void }>();

const session = useSession();

const visible = computed({
  get: () => props.open,
  set: (open: boolean) => {
    if (!open) emit('close');
  },
});

const fileName = ref('');
const contentBase64 = ref('');
const preview = ref<ArchivePreviewResponse | null>(null);
const confirmPassword = ref('');
const reading = ref(false);
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);

watch(
  () => props.open,
  (open) => {
    if (open) return;
    fileName.value = '';
    contentBase64.value = '';
    preview.value = null;
    confirmPassword.value = '';
    error.value = null;
  },
);

const canRestore = computed(
  () => !busy.value && preview.value?.canRestore === true && confirmPassword.value !== '',
);

async function onFile(event: Event): Promise<void> {
  const token = session.accessToken.value;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (token === null || file === undefined) return;

  reading.value = true;
  error.value = null;
  preview.value = null;
  try {
    fileName.value = file.name;
    contentBase64.value = await toBase64(file);
    preview.value = await inspectArchive(token, fileName.value, contentBase64.value);
  } catch (cause) {
    error.value = describe(cause, 'That file could not be read.');
  } finally {
    reading.value = false;
  }
}

async function restore(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || !canRestore.value) return;

  busy.value = true;
  error.value = null;
  try {
    await restoreArchive(token, fileName.value, contentBase64.value, confirmPassword.value);
    emit('restored');
    // The identity this session belonged to no longer exists. Signing out is
    // not tidiness — the account that performed the restore has been replaced.
    session.clear();
    window.location.assign('/login');
  } catch (cause) {
    error.value = describe(cause, 'The backup could not be restored.');
  } finally {
    busy.value = false;
  }
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  if (cause instanceof ApiError) return { code: cause.code, message: cause.message };
  return { code: 'UNKNOWN', message: fallback };
}

/**
 * The archive travels base64 in the body, like every other upload on this API.
 * `FileReader` is what keeps a large file off the main thread while it is
 * encoded.
 */
async function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(new Error('The file could not be read from disk.'));
    };
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

function whenText(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    modal
    header="Restore a backup — ব্যাকআপ ফিরিয়ে আনুন"
    :style="{ width: 'min(42rem, 94vw)' }"
  >
    <div class="restore">
      <p class="restore__intro">
        Choose a <code>.sherdb</code> file. SherERP will read it and show you what is inside before
        anything is written.
        <span class="label-bn">কিছু লেখার আগে ফাইলে কী আছে দেখানো হবে।</span>
      </p>

      <ErrorNotice v-if="error !== null" :code="error.code" :message="error.message" />

      <div class="field">
        <label for="restore-file">Backup file <span class="label-bn">ব্যাকআপ ফাইল</span></label>
        <input id="restore-file" type="file" accept=".sherdb" @change="onFile" />
        <p v-if="reading" class="field__hint">Reading the file…</p>
      </div>

      <section v-if="preview !== null" class="restore__preview">
        <h3>{{ preview.businessName }}</h3>
        <dl>
          <div><dt>Taken</dt><dd>{{ whenText(preview.takenAt) }}</dd></div>
          <div><dt>Made by</dt><dd>SherERP {{ preview.appVersion }} ({{ preview.archiveSchemaVersion }})</dd></div>
          <div><dt>This computer</dt><dd>{{ preview.buildSchemaVersion }}</dd></div>
          <div><dt>Rows</dt><dd>{{ preview.totalRows.toLocaleString('en-GB') }}</dd></div>
        </dl>

        <ul class="restore__contents">
          <li v-for="entry in preview.contents" :key="entry.label">
            <span>{{ entry.label }}</span>
            <strong>{{ entry.rows.toLocaleString('en-GB') }}</strong>
          </li>
        </ul>

        <p v-if="preview.blockedReason !== null" class="restore__blocked">
          {{ preview.blockedReason }}
        </p>
      </section>

      <div v-if="preview?.canRestore === true" class="field">
        <label for="restore-confirm">Your own password <span class="label-bn">আপনার পাসওয়ার্ড</span></label>
        <input
          id="restore-confirm"
          v-model="confirmPassword"
          type="password"
          autocomplete="current-password"
          placeholder="The password you sign in with"
        />
        <p class="field__hint">
          After this, sign in with an account from the restored business — this recovery account
          will no longer exist.
        </p>
      </div>

      <footer class="restore__footer">
        <button type="button" class="btn-ghost" @click="emit('close')">Cancel</button>
        <button type="button" class="btn-primary" :disabled="!canRestore" @click="restore">
          {{ busy ? 'Restoring…' : 'Restore this backup' }}
        </button>
      </footer>
    </div>
  </Dialog>
</template>

<style scoped>
.field__hint {
  margin: 0.3rem 0 0;
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
  line-height: 1.45;
}

.restore {
  display: grid;
  gap: 1rem;
}

.restore__intro {
  margin: 0;
  line-height: 1.5;
}

.restore__preview {
  border: 1px solid var(--sher-border, #e4e4e7);
  border-radius: var(--sher-radius-sm, 6px);
  padding: 0.85rem;
}

.restore__preview h3 {
  margin: 0 0 0.5rem;
  font-size: 1.05rem;
}

.restore__preview dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.35rem 1rem;
  margin: 0 0 0.75rem;
}

.restore__preview dl div {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.restore__preview dt {
  color: var(--sher-ink-muted, #52525b);
}

.restore__preview dd {
  margin: 0;
  font-weight: 600;
}

.restore__contents {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.2rem 1rem;
}

.restore__contents li {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}

.restore__blocked {
  margin: 0.75rem 0 0;
  padding: 0.7rem 0.8rem;
  border-radius: var(--sher-radius-sm, 6px);
  background: var(--sher-warning-soft, #fff6e5);
  color: var(--sher-warning-ink, #6b4a00);
  line-height: 1.5;
}

.restore__footer {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}

@media (max-width: 34rem) {
  .restore__preview dl,
  .restore__contents {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
