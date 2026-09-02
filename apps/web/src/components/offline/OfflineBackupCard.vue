<script setup lang="ts">
import {
  exportBackup,
  importBackup,
  readLocalState,
  readManifest,
} from '@sher/adapter-sqlite-wasm';
import { computed, ref } from 'vue';

import { ApiError } from '../../api/client';
import { pendingSummary } from '../../offline/local-writer';
import { storedTenantId } from '../../offline/snapshot';

/**
 * The day in a file the shop keeps (§20, §21, Phase 12.4).
 *
 * OPFS can be evicted by the browser without asking anybody, and a counter PC
 * can die on a Thursday. Either takes with it whatever this machine has not
 * sent, so the shop must be able to put that work somewhere it controls — and
 * put it back.
 *
 * **The passphrase is the shop's, and nobody can recover it.** The archive
 * holds every customer, every price and every sale this machine has made; a
 * plain SQLite file on a USB stick in a drawer is a copy of the shop. That is
 * said on the card in words rather than hidden behind a lock icon, because a
 * shopkeeper who loses the passphrase has lost the file, and finding that out
 * afterwards is too late.
 *
 * **Restoring does not make this machine the offline writer.** The queue, the
 * operation ids, the printed numbers and the device sequence all come back
 * exactly as they were, and the authority to create *new* work is still the
 * shop's to grant through Replace Writer. Counter A's documents restored onto
 * Counter B stay Counter A's documents.
 */
const passphrase = ref('');
const confirmPassphrase = ref('');
const restorePassphrase = ref('');
const busy = ref(false);
const message = ref<string | null>(null);
const failure = ref<string | null>(null);
const chosen = ref<File | null>(null);
const chosenManifest = ref<{ takenAt: string; pendingOperations: number } | null>(null);

const canExport = computed(
  () => passphrase.value.length >= 8 && passphrase.value === confirmPassphrase.value,
);

async function save(): Promise<void> {
  busy.value = true;
  failure.value = null;
  message.value = null;
  try {
    const state = await readLocalState();
    const tenantId = storedTenantId();
    if (tenantId === null) throw new Error('This computer does not hold a copy of the shop yet');

    const held = await pendingSummary();
    const backup = await exportBackup({
      passphrase: passphrase.value,
      tenantId,
      deviceId: state?.deviceId ?? null,
      deviceCode: state?.deviceCode ?? null,
      schemaVersion: 2,
      pendingOperations: held.pending,
      syncCursor: state?.syncCursor ?? null,
      takenAt: new Date().toISOString(),
    });

    const blob = new Blob([backup.bytes], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sher-${state?.deviceCode ?? 'device'}-${backup.manifest.takenAt.slice(0, 10)}.sherbak`;
    link.click();
    URL.revokeObjectURL(url);

    message.value = `Saved. It holds ${String(held.pending)} thing(s) still waiting to be sent.`;
    passphrase.value = '';
    confirmPassphrase.value = '';
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : 'Could not make the backup';
  } finally {
    busy.value = false;
  }
}

async function choose(event: Event): Promise<void> {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null;
  chosen.value = file;
  chosenManifest.value = null;
  failure.value = null;
  if (file === null) return;
  const manifest = readManifest(new Uint8Array(await file.arrayBuffer()));
  if (manifest === null) {
    failure.value = 'That is not a SherERP backup file';
    return;
  }
  chosenManifest.value = {
    takenAt: manifest.takenAt,
    pendingOperations: manifest.pendingOperations,
  };
}

async function restore(): Promise<void> {
  const file = chosen.value;
  const tenantId = storedTenantId();
  if (file === null || tenantId === null) return;
  busy.value = true;
  failure.value = null;
  message.value = null;
  try {
    const manifest = await importBackup(
      new Uint8Array(await file.arrayBuffer()),
      restorePassphrase.value,
      tenantId,
    );
    message.value =
      `Restored the copy taken on ${new Date(manifest.takenAt).toLocaleString()}. ` +
      `${String(manifest.pendingOperations)} thing(s) are waiting to be sent. ` +
      'This computer can send them up, but it cannot make new offline work until the shop gives it offline permission again.';
    chosen.value = null;
    chosenManifest.value = null;
    restorePassphrase.value = '';
  } catch (cause) {
    failure.value =
      cause instanceof ApiError || cause instanceof Error
        ? cause.message
        : 'Could not open that backup';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card">
    <h2>Backup this computer’s work</h2>
    <p class="bn">এই কম্পিউটারের কাজ ফাইলে রাখুন</p>
    <p class="explain">
      A copy of everything this computer is holding, in one encrypted file you keep. Do this
      whenever work is waiting to be sent and the day is ending.
      <span class="bn">
        ইন্টারনেট না থাকলে যে কাজগুলো এখানে জমা আছে, সেগুলোর একটি নিরাপদ কপি।
      </span>
    </p>

    <p v-if="message !== null" class="ok">{{ message }}</p>
    <p v-if="failure !== null" class="bad">{{ failure }}</p>

    <div class="grid">
      <label>
        Passphrase
        <span class="bn">পাসফ্রেজ</span>
        <input v-model="passphrase" type="password" autocomplete="new-password" />
      </label>
      <label>
        Type it again
        <span class="bn">আবার লিখুন</span>
        <input v-model="confirmPassphrase" type="password" autocomplete="new-password" />
      </label>
    </div>
    <p class="warn">
      Nobody can open this file without that passphrase — not the shop, not support, not us.
      Write it somewhere safe.
      <span class="bn">পাসফ্রেজ হারালে ফাইলটি আর খোলা যাবে না।</span>
    </p>
    <button type="button" class="primary" :disabled="!canExport || busy" @click="save">
      Save a copy
      <span class="bn-inline">কপি রাখুন</span>
    </button>

    <hr />

    <h3>Put a backup back</h3>
    <p class="bn">আগের কপি ফিরিয়ে আনুন</p>
    <input type="file" accept=".sherbak" @change="choose" />
    <p v-if="chosenManifest !== null" class="explain">
      Taken {{ new Date(chosenManifest.takenAt).toLocaleString() }} ·
      {{ chosenManifest.pendingOperations }} waiting to be sent
    </p>
    <label v-if="chosen !== null">
      Passphrase
      <span class="bn">পাসফ্রেজ</span>
      <input v-model="restorePassphrase" type="password" autocomplete="current-password" />
    </label>
    <p class="warn">
      Putting a backup back replaces what this computer is holding now, and does not give it
      permission to work offline again — the shop grants that separately.
      <span class="bn">
        ফিরিয়ে আনলেই অফলাইনে কাজ করার অনুমতি ফিরে আসে না।
      </span>
    </p>
    <button
      type="button"
      :disabled="chosen === null || restorePassphrase.length === 0 || busy"
      @click="restore"
    >
      Put it back
      <span class="bn-inline">ফিরিয়ে আনুন</span>
    </button>
  </section>
</template>

<style scoped>
.card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: var(--sher-radius, 8px);
  background: var(--sher-surface);
}

h2 {
  margin: 0;
  font-size: 17px;
}

h3 {
  margin: 0;
  font-size: 15px;
}

.bn {
  display: block;
  font-size: 12px;
  color: var(--sher-text-muted);
}

.bn-inline {
  margin-left: 6px;
  font-size: 11px;
  opacity: 0.85;
}

.explain,
.warn {
  margin: 0;
  font-size: 13px;
}

.warn {
  color: var(--sher-text-muted);
}

.ok {
  margin: 0;
  font-size: 13px;
  color: var(--sher-success, #1e8449);
}

.bad {
  margin: 0;
  font-size: 13px;
  color: var(--sher-danger, #c0392b);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 10px;
}

label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}

input[type='password'] {
  min-height: 40px;
  padding: 6px 10px;
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: var(--sher-radius, 8px);
}

button {
  align-self: flex-start;
  min-height: 40px;
  padding: 8px 16px;
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: var(--sher-radius, 8px);
  background: var(--sher-surface);
  cursor: pointer;
}

button.primary {
  background: var(--sher-primary, #1b5e20);
  color: #fff;
  border-color: transparent;
}

hr {
  border: none;
  border-top: var(--sher-border-w) solid var(--sher-line);
  margin: 4px 0;
}
</style>
