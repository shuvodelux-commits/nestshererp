<script setup lang="ts">
import type { BackupStatusResponse } from '@sher/core-contracts';
import { computed, onMounted, ref } from 'vue';

import { downloadBackup, fetchBackupStatus } from '../api/backup';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import ReplaceBackupSecretDialog from '../components/backup/ReplaceBackupSecretDialog.vue';
import ResetBusinessDialog from '../components/backup/ResetBusinessDialog.vue';
import RestoreDialog from '../components/backup/RestoreDialog.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * Settings → Backup · ব্যাকআপ (Phase 10, §5.25, owner decisions 2026-08-30).
 *
 * Four things on one page, in the order a shop needs them: is a backup password
 * set, is the nightly backup working, download a copy, and — at the very foot,
 * never in a menu — the two operations that empty or replace this installation.
 *
 * **Reset lives here on purpose.** The person about to clear the database has
 * just read the date of the last downloaded backup, on the same screen, without
 * having to go and look for it.
 *
 * The wording rule the owner set: nothing here claims a backup is safely off
 * this computer, because nothing has confirmed that it is. It says what is
 * true — when a copy was last downloaded from this server.
 */
const session = useSession();

const status = ref<BackupStatusResponse | null>(null);
const loading = ref(true);
const downloading = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const secretOpen = ref(false);
const restoreOpen = ref(false);
const resetOpen = ref(false);
const passwordPrompt = ref('');
const askingPassword = ref(false);

const canRestore = computed(() => session.can('backup.restore'));
const canReset = computed(() => session.can('business.reset'));

const lastAutomaticText = computed(() => {
  const run = status.value?.lastAutomatic;
  if (run === undefined || run === null) return 'No automatic backup has run yet.';
  if (run.status === 'SUCCESS') {
    return `Last automatic backup: ${when(run.finishedAt)} — checked and readable.`;
  }
  return `Last automatic backup failed on ${when(run.startedAt)}.`;
});

const manualText = computed(() => {
  const at = status.value?.lastManualExportAt ?? null;
  if (at === null) return 'No backup has ever been downloaded from this computer.';
  const days = status.value?.daysSinceManualExport ?? 0;
  return `Last downloaded from this computer: ${when(at)} (${String(days)} days ago).`;
});

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  try {
    status.value = await fetchBackupStatus(token);
  } catch (cause) {
    failure.value = describe(cause, 'Could not read the backup status');
  } finally {
    loading.value = false;
  }
}

async function download(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null || passwordPrompt.value === '') return;

  downloading.value = true;
  failure.value = null;
  try {
    const archive = await downloadBackup(token, passwordPrompt.value);
    saveToDisk(archive.fileName, archive.blob);
    passwordPrompt.value = '';
    askingPassword.value = false;
    await load();
  } catch (cause) {
    failure.value = describe(cause, 'The backup could not be created');
  } finally {
    downloading.value = false;
  }
}

/**
 * Hands the file to the browser's own download.
 *
 * An object URL rather than a data URL: a `.sherdb` archive can be hundreds of
 * megabytes, and a data URL of that size would be built as one string in
 * memory before the browser saw a byte of it.
 */
function saveToDisk(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function when(iso: string | null): string {
  return iso === null
    ? 'never'
    : new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  if (cause instanceof ApiError) return { code: cause.code, message: cause.message };
  return { code: 'UNKNOWN', message: fallback };
}

onMounted(load);
</script>

<template>
  <AppShell
    title="Backup"
    :breadcrumb="['Dashboard', 'Settings', 'Backup']"
    help-bn="ব্যাকআপ — সারা ব্যবসার একটা কপি, একটাই ফাইলে"
  >
    <div class="bk">
      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <AppCard v-if="status != null && !status.secretConfigured" class="bk__alert bk__alert--bad">
        <h2>No backup password is set</h2>
        <p>
          Nothing can be encrypted until you set one, so no backup is being taken at all. Set it
          now, write it down, and keep it somewhere safe — there is no way to recover it.
        </p>
        <button type="button" class="btn-primary" @click="secretOpen = true">
          Set backup password
        </button>
      </AppCard>

      <AppCard v-if="status?.automaticFailing" class="bk__alert bk__alert--bad">
        <h2>The automatic backup is failing</h2>
        <p>{{ status.lastAutomatic?.error ?? 'The last automatic backup did not complete.' }}</p>
      </AppCard>

      <AppCard v-if="status?.manualExportOverdue" class="bk__alert bk__alert--warn">
        <h2>Take a copy off this computer</h2>
        <p>
          {{ manualText }} A backup that only exists on this computer is lost with this computer.
          Download one and keep it on a pen drive or another machine.
        </p>
      </AppCard>

      <AppCard>
        <h2 class="bk__title">Automatic backup <span class="label-bn">প্রতি রাতের ব্যাকআপ</span></h2>
        <p class="bk__line">{{ lastAutomaticText }}</p>
        <p class="bk__line bk__line--muted">
          One backup is made every night, checked by reading it back, and the newest
          {{ status?.retentionLimit ?? 14 }} are kept on this computer
          ({{ status?.retainedCount ?? 0 }} at the moment).
        </p>
      </AppCard>

      <AppCard>
        <h2 class="bk__title">Download a backup <span class="label-bn">ব্যাকআপ নামান</span></h2>
        <p class="bk__line">{{ manualText }}</p>

        <div v-if="askingPassword" class="bk__ask">
          <div class="field">
            <label for="bk-password">Your own password <span class="label-bn">আপনার পাসওয়ার্ড</span></label>
            <input
              id="bk-password"
              v-model="passwordPrompt"
              type="password"
              autocomplete="current-password"
              placeholder="The password you sign in with"
              @keyup.enter="download"
            />
          </div>
          <div class="bk__actions">
            <button type="button" class="btn-ghost" @click="askingPassword = false">Cancel</button>
            <button
              type="button"
              class="btn-primary"
              :disabled="downloading || passwordPrompt === ''"
              @click="download"
            >
              {{ downloading ? 'Preparing…' : 'Download' }}
            </button>
          </div>
        </div>

        <button
          v-else
          type="button"
          class="btn-primary"
          :disabled="status?.secretConfigured !== true"
          @click="askingPassword = true"
        >
          Download backup
        </button>
      </AppCard>

      <AppCard>
        <h2 class="bk__title">Backup password <span class="label-bn">ব্যাকআপের পাসওয়ার্ড</span></h2>
        <p class="bk__line bk__line--muted">
          Every backup file is locked with one password, kept on this computer outside the database.
          SherERP never shows it. You can replace it — backups already taken stay locked with the
          old one.
        </p>
        <button type="button" class="btn-ghost" @click="secretOpen = true">
          {{ status?.secretConfigured === true ? 'Change backup password' : 'Set backup password' }}
        </button>
      </AppCard>

      <AppCard v-if="canRestore">
        <h2 class="bk__title">Restore a backup <span class="label-bn">ব্যাকআপ ফিরিয়ে আনুন</span></h2>
        <p class="bk__line bk__line--muted">
          A backup can only be restored into an empty installation, and restoring never deletes
          anything.
          <template v-if="status?.businessEmpty === false">
            This installation already has business data in it, so restore is not available until it
            is cleared below.
          </template>
        </p>
        <button
          type="button"
          class="btn-ghost"
          :disabled="status?.businessEmpty !== true"
          @click="restoreOpen = true"
        >
          Restore from a file
        </button>
      </AppCard>

      <AppCard v-if="canReset" class="bk__danger">
        <h2 class="bk__title">Reset business data <span class="label-bn">সব হিসাব মুছে ফেলুন</span></h2>
        <p class="bk__line bk__line--muted">
          Empties this installation so a backup can be restored into it. A recovery copy of the
          database is made and checked first. Your users and roles stay.
        </p>
        <p class="bk__line">{{ manualText }}</p>
        <button type="button" class="btn-danger" @click="resetOpen = true">
          Reset business data
        </button>
      </AppCard>

      <p v-if="loading" class="bk__line bk__line--muted">Loading…</p>
    </div>

    <ReplaceBackupSecretDialog
      :open="secretOpen"
      :already-set="status?.secretConfigured === true"
      @close="secretOpen = false"
      @saved="load"
    />
    <RestoreDialog :open="restoreOpen" @close="restoreOpen = false" @restored="load" />
    <ResetBusinessDialog
      :open="resetOpen"
      :last-backup-at="status?.lastManualExportAt ?? null"
      @close="resetOpen = false"
      @reset="load"
    />
  </AppShell>
</template>

<style scoped>
.bk {
  display: grid;
  gap: 1rem;
  max-width: 52rem;
}

.bk__title {
  margin: 0 0 0.4rem;
  font-size: 1rem;
}

.bk__line {
  margin: 0 0 0.6rem;
  line-height: 1.5;
}

.bk__line--muted {
  color: var(--sher-text-muted);
}

.bk__alert h2 {
  margin: 0 0 0.4rem;
  font-size: 1rem;
}

.bk__alert p {
  margin: 0 0 0.6rem;
  line-height: 1.5;
}

.bk__alert--bad {
  border-left: 3px solid var(--sher-danger, #b91c1c);
}

.bk__alert--warn {
  border-left: 3px solid var(--sher-warning, #d97706);
}

.bk__danger {
  border-left: 3px solid var(--sher-danger, #b91c1c);
}

.bk__ask {
  display: grid;
  gap: 0.6rem;
  max-width: 24rem;
}

.bk__actions {
  display: flex;
  gap: 0.5rem;
}
</style>
