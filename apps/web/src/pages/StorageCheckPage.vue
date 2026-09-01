<script setup lang="ts">
import { computed, ref } from 'vue';

import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import { bytesText } from '../components/offline/offline-text';
import AppShell from '../components/shell/AppShell.vue';
import { availableBytes, isInstalled, isPersisted, requestPersistence } from '../offline/gate';
import { useOfflineStatus } from '../offline/status';

/**
 * Storage check · জায়গার পরীক্ষা — the O-6 spike, run on real hardware (owner
 * decision 2026-08-31).
 *
 * Open item O-6 asks for numbers nobody can honestly produce in a development
 * container: SQLite WASM cold-start, how long a snapshot-sized import takes,
 * the real quota on a low-end shop PC, and what a browser does when `persist()`
 * is refused. So the spike ships **as a page the owner opens on the actual
 * machine**: it writes a real SQLite database into OPFS, times it, prints
 * figures that can be pasted straight into the SRS, and deletes everything it
 * made.
 *
 * It touches no business data — it cannot, because it never asks the API for
 * any — and it writes only inside its own VFS pool, which it removes at the
 * end. Running it on the counter PC costs a few seconds and nothing else.
 */
const { status } = useOfflineStatus();

const running = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);
const log = ref<readonly { label: string; value: string }[]>([]);

/** Rows per transaction — a batch size a real import would actually use. */
const BATCH = 2000;
const TARGET_ROWS = 50_000;

const requiredBytes = computed(() => status.value?.requiredBytes ?? null);
const snapshotBytes = computed(() => status.value?.snapshotBytes ?? null);

function add(label: string, value: string): void {
  log.value = [...log.value, { label, value }];
}

async function run(): Promise<void> {
  running.value = true;
  failure.value = null;
  log.value = [];

  try {
    add('App is installed', isInstalled() ? 'yes' : 'no — running in a browser tab');
    const persistedAlready = await isPersisted();
    add('Permanent storage granted', persistedAlready ? 'yes' : 'no');
    if (!persistedAlready) {
      // SY-13's question, asked out loud: what does this browser do when we ask?
      add('persist() when asked', (await requestPersistence()) ? 'granted' : 'refused');
    }

    const before = await availableBytes();
    add('Free space before', bytesText(before));

    const started = performance.now();
    const sqlite3InitModule = (await import('@sqlite.org/sqlite-wasm')).default;
    const sqlite3 = await sqlite3InitModule();
    add('SQLite WASM cold start', `${Math.round(performance.now() - started).toString()} ms`);
    add('SQLite version', String(sqlite3.version.libVersion));

    /*
     * The SAH-pool VFS rather than the plain OPFS one, deliberately: it needs
     * no COOP/COEP headers, and those headers would break Google sign-in — so
     * the whole offline design rests on this VFS working here.
     */
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'sher-storage-check' });
    const db = new pool.OpfsSAHPoolDb('/storage-check.sqlite3');

    try {
      db.exec('CREATE TABLE probe (id TEXT PRIMARY KEY, a TEXT, b TEXT, c INTEGER, d INTEGER)');

      // Shaped like the biggest table a snapshot carries — journal lines — so
      // the timing means something instead of measuring an empty file.
      const writeStart = performance.now();
      for (let written = 0; written < TARGET_ROWS; written += BATCH) {
        db.exec('BEGIN');
        for (let i = 0; i < BATCH; i += 1) {
          db.exec({
            sql: 'INSERT INTO probe VALUES (?, ?, ?, ?, ?)',
            bind: [
              String(written + i).padStart(26, '0'),
              'ACCOUNTS_RECEIVABLE',
              'a description of roughly the length a real one has',
              written + i,
              Date.now(),
            ],
          });
        }
        db.exec('COMMIT');
      }
      const writeMs = performance.now() - writeStart;
      add('Wrote 50,000 rows', `${Math.round(writeMs).toString()} ms`);
      add('Per 1,000 rows', `${Math.round(writeMs / 50).toString()} ms`);

      const readStart = performance.now();
      db.exec({ sql: 'SELECT COUNT(*) FROM probe', returnValue: 'resultRows' });
      add('Counting every row', `${Math.round(performance.now() - readStart).toString()} ms`);

      const after = await availableBytes();
      add('Free space after', bytesText(after));
      if (before !== null && after !== null) {
        add('50,000 rows cost', bytesText(Math.max(0, before - after)));
      }
    } finally {
      db.close();
      await pool.removeVfs();
    }

    const free = await availableBytes();
    add('Free space after cleanup', bytesText(free));
    if (requiredBytes.value !== null) {
      add('This shop’s snapshot needs', bytesText(snapshotBytes.value));
      add('With working headroom', bytesText(requiredBytes.value));
      add(
        'Verdict',
        free !== null && free >= requiredBytes.value
          ? 'this computer has room'
          : 'this computer does not have room',
      );
    }
  } catch (cause) {
    failure.value = {
      code: 'STORAGE_CHECK_FAILED',
      message: cause instanceof Error ? cause.message : 'The storage check could not finish.',
    };
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <AppShell
    title="Storage check"
    :breadcrumb="['Dashboard', 'Settings', 'Offline & Devices', 'Storage check']"
    help-bn="জায়গার পরীক্ষা — এই কম্পিউটার অফলাইনে কতটা সামলাতে পারবে"
  >
    <div class="sc">
      <AppCard title="What this does" subtitle-bn="এটা কী করে">
        <p class="sc__lede">
          It writes a real database onto this computer, times it, and deletes it again. The shop’s
          own data is never touched, and nothing is kept. Run it on the machine that will work
          offline, then send the numbers on.
        </p>

        <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

        <div class="sc__actions">
          <button type="button" class="btn btn-primary" :disabled="running" @click="run">
            {{ running ? 'Running…' : 'Run the check' }}
            <span class="label-bn">পরীক্ষা চালান</span>
          </button>
        </div>
      </AppCard>

      <AppCard v-if="log.length > 0" title="Results" subtitle-bn="ফলাফল">
        <dl class="sc__log">
          <div v-for="entry in log" :key="entry.label">
            <dt>{{ entry.label }}</dt>
            <dd>{{ entry.value }}</dd>
          </div>
        </dl>
      </AppCard>
    </div>
  </AppShell>
</template>

<style scoped>
.sc {
  display: grid;
  gap: var(--sher-space-4);
}

.sc__lede {
  margin: 0 0 var(--sher-space-3);
  color: var(--sher-text-muted);
}

.sc__log {
  display: grid;
  gap: var(--sher-space-2);
  margin: 0;
}

.sc__log > div {
  display: flex;
  justify-content: space-between;
  gap: var(--sher-space-3);
  padding-bottom: var(--sher-space-2);
  border-bottom: var(--sher-border-w) solid var(--sher-line);
}

.sc__log dt {
  color: var(--sher-text-muted);
}

.sc__log dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
</style>
