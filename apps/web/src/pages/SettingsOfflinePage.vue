<script setup lang="ts">
import OfflineBackupCard from '../components/offline/OfflineBackupCard.vue';
import type { DeviceResponse } from '@sher/core-contracts';
import Tag from 'primevue/tag';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import {
  approveDevice,
  fetchDevices,
  forceRevokeDevice,
  registerDevice,
  renameDevice,
  replaceWriter,
  requestOfflineWrite,
  revokeDevice,
} from '../api/devices';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import DeviceNameDialog from '../components/offline/DeviceNameDialog.vue';
import ForceRevokeDialog from '../components/offline/ForceRevokeDialog.vue';
import ReplaceWriterDialog from '../components/offline/ReplaceWriterDialog.vue';
import {
  bytesText,
  DEVICE_STATUS_TEXT,
  GATE_STEPS,
  OFFLINE_BN,
  SNAPSHOT_BN,
} from '../components/offline/offline-text';
import AppShell from '../components/shell/AppShell.vue';
import { useSnapshot } from '../offline/snapshot';
import { useSync } from '../offline/sync';
import { requestPersistence } from '../offline/gate';
import { deviceKey, suggestedDeviceName, describeThisBrowser } from '../offline/identity';
import { promptInstall, useAppUpdates } from '../offline/service-worker';
import { useOfflineStatus } from '../offline/status';

/**
 * Offline & Devices · অফলাইন ও কম্পিউটার (§5.23, D-01, D-24, owner decisions
 * 2026-08-31).
 *
 * Two questions, one screen. The top half answers "can *this* computer work
 * offline, and if not, what exactly is missing?" — the D-24 ladder with the
 * failed rung named in words a shopkeeper can act on, and the single button
 * that fixes it. The bottom half answers "which computer is the shop's offline
 * computer?", and is only drawn for whoever may change that (UI-09).
 *
 * **Nothing on this page claims the shop can trade without internet.** Passing
 * every check is `Offline setup ready`: the door is built, the room behind it
 * is the next module. Saying otherwise would be the one lie this whole gate
 * exists to prevent.
 */
const session = useSession();
const { status, measurement, gate, state, blockedAt, refresh } = useOfflineStatus();
const { installAvailable } = useAppUpdates();

const devices = ref<readonly DeviceResponse[]>([]);
const loading = ref(true);
const busy = ref(false);
const failure = ref<{ code: string; message: string } | null>(null);

const registering = ref(false);
const approving = ref<DeviceResponse | null>(null);
const renaming = ref<DeviceResponse | null>(null);
const forcing = ref<DeviceResponse | null>(null);
const replacing = ref<DeviceResponse | null>(null);

const thisDevice = computed(() => status.value?.device ?? null);
const canApprove = computed(() => status.value?.canApprove === true);
const canForce = computed(() => status.value?.canForceRevoke === true);
/* Owner-only in every seeded role, and named that way rather than by inventing
   a sixth permission code for one diagnostics screen. */
const canRunStorageCheck = computed(() => session.can('settings.setting.edit'));

/*
 * Phase 18.3. Sync lost its own sidebar entry and folded in here; the same
 * permission still decides whether anybody sees it, so a role that never works
 * an outage finds no trace of the subject on this page either (UI-09).
 */
const canSeeSync = computed(() => session.can('sync.status.view'));
const sync = useSync();

const writer = computed(() => devices.value.find((device) => device.status === 'ACTIVE') ?? null);
const draining = computed(() => devices.value.find((device) => device.status === 'DRAINING') ?? null);
const slotHolder = computed(() => writer.value ?? draining.value);

const steps = computed(() =>
  (gate.value?.steps ?? []).map((entry) => ({
    ...entry,
    copy: GATE_STEPS[entry.step],
    isBlocker: entry.step === blockedAt.value,
  })),
);

const spaceLine = computed(() => {
  const required = status.value?.requiredBytes ?? null;
  const free = measurement.value?.availableBytes ?? null;
  if (required === null) return '';
  return `Needs about ${bytesText(required)}, this computer has ${bytesText(free)} free.`;
});

async function load(): Promise<void> {
  const token = session.accessToken.value;
  if (token === null) return;
  loading.value = true;
  failure.value = null;
  try {
    await refresh();
    if (status.value?.canApprove === true) {
      const list = await fetchDevices(token, await deviceKey());
      devices.value = list.devices;
    }
  } catch (cause) {
    failure.value = describe(cause, 'The computer list could not be read.');
  } finally {
    loading.value = false;
  }
}

function describe(cause: unknown, fallback: string): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'REQUEST_FAILED', message: fallback };
}

/** One place where every action lands, so a failure always reaches the screen. */
async function act(work: () => Promise<void>): Promise<void> {
  busy.value = true;
  failure.value = null;
  try {
    await work();
    await load();
  } catch (cause) {
    failure.value = describe(cause, 'That did not work. Try again.');
  } finally {
    busy.value = false;
  }
}

async function register(name: string): Promise<void> {
  const token = session.accessToken.value ?? '';
  const key = await deviceKey();
  if (key === null) {
    failure.value = {
      code: 'NO_DEVICE_IDENTITY',
      message: 'This browser will not let the app keep an identity. Try a normal (not private) window.',
    };
    return;
  }
  await act(async () => {
    await registerDevice(token, { publicKey: key, name, platform: describeThisBrowser() });
    registering.value = false;
  });
}

async function askForOffline(): Promise<void> {
  const token = session.accessToken.value ?? '';
  const key = await deviceKey();
  if (key === null) return;
  await act(async () => {
    await requestOfflineWrite(token, key);
  });
}

async function allowStorage(): Promise<void> {
  await act(async () => {
    const granted = await requestPersistence();
    if (!granted) {
      failure.value = {
        code: 'STORAGE_NOT_PERSISTED',
        message:
          'The browser did not agree to keep this shop’s data. Install the app and use it for a few days, then try again.',
      };
    }
  });
}

async function install(): Promise<void> {
  await act(async () => {
    await promptInstall();
  });
}

async function approve(name: string): Promise<void> {
  const device = approving.value;
  if (device === null) return;
  const token = session.accessToken.value ?? '';
  await act(async () => {
    await approveDevice(token, await deviceKey(), { deviceId: device.id, name });
    approving.value = null;
  });
}

async function rename(name: string): Promise<void> {
  const device = renaming.value;
  if (device === null) return;
  const token = session.accessToken.value ?? '';
  await act(async () => {
    await renameDevice(token, await deviceKey(), { deviceId: device.id, name });
    renaming.value = null;
  });
}

async function revoke(device: DeviceResponse): Promise<void> {
  const token = session.accessToken.value ?? '';
  await act(async () => {
    await revokeDevice(token, await deviceKey(), { deviceId: device.id });
  });
}

async function cutOff(payload: { password: string; reason: string }): Promise<void> {
  const device = forcing.value;
  if (device === null) return;
  const token = session.accessToken.value ?? '';
  await act(async () => {
    await forceRevokeDevice(token, await deviceKey(), { deviceId: device.id, ...payload });
    forcing.value = null;
  });
}

async function handOver(payload: {
  name: string;
  forceOldDevice: boolean;
  password?: string;
  reason?: string;
}): Promise<void> {
  const device = replacing.value;
  if (device === null) return;
  const token = session.accessToken.value ?? '';
  await act(async () => {
    await replaceWriter(token, await deviceKey(), { deviceId: device.id, ...payload });
    replacing.value = null;
  });
}

/** The one button that fixes the step the gate is stuck on. */
async function fixBlocker(): Promise<void> {
  const action = blockedAt.value === null ? null : GATE_STEPS[blockedAt.value].action;
  if (action === 'INSTALL') await install();
  else if (action === 'PERSIST') await allowStorage();
  else if (action === 'REQUEST') await askForOffline();
  else await load();
}

function statusText(device: DeviceResponse): { label: string; bn: string; tone: string } {
  return (
    DEVICE_STATUS_TEXT[device.status] ?? { label: device.status, bn: '', tone: 'secondary' }
  );
}

function when(value: string | null): string {
  if (value === null) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Dhaka',
  }).format(new Date(value));
}


/*
 * Phase 12.3 — the copy of the shop's data, and the numbers it cost.
 *
 * This card exists only on the machine that holds the shop's offline
 * authority. `DRAINING` counts: a machine being handed over is finishing its
 * work, not starting new work, and blanking its screens mid-handover would
 * help nobody.
 */
const {
  stored: snapshot,
  bytes: snapshotBytes,
  downloading: snapshotBusy,
  failure: snapshotFailure,
  ageInDays: snapshotAge,
  isStale: snapshotStale,
  refresh: refreshSnapshotCopy,
  reload: reloadSnapshotCopy,
} = useSnapshot();

const holdsOfflineAuthority = computed(
  () => thisDevice.value?.status === 'ACTIVE' || thisDevice.value?.status === 'DRAINING',
);

const snapshotTakenAt = computed<string>(() => {
  const takenAt = snapshot.value?.takenAt;
  if (takenAt === undefined) return '—';
  const taken = Date.parse(takenAt);
  if (Number.isNaN(taken)) return '—';
  // UI-33: never a raw UTC instant. The shop's own clock, in Western digits.
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(taken);
});

/** Which lists the copy holds — the permissions of whoever last refreshed it. */
const snapshotHolds = computed<string>(() => {
  const includes = snapshot.value?.includes;
  if (includes === undefined) return '—';
  const held = [
    includes.products ? 'products' : null,
    includes.customers ? 'customers' : null,
    includes.suppliers ? 'suppliers' : null,
    includes.vendors ? 'vendors' : null,
  ].filter((part): part is string => part !== null);
  if (held.length === 0) return 'nothing';
  return includes.cost ? `${held.join(', ')} (with cost prices)` : held.join(', ');
});

async function refreshSnapshotNow(): Promise<void> {
  await refreshSnapshotCopy();
  await load();
}

onMounted(async () => {
  await load();
  // What is already on this machine, before any download is considered.
  await reloadSnapshotCopy();
});
</script>

<template>
  <AppShell
    title="Offline & Devices"
    :breadcrumb="['Dashboard', 'Settings', 'Offline & Devices']"
    :help-bn="`${OFFLINE_BN.page} — কোন কম্পিউটার ইন্টারনেট ছাড়া কাজ করার জন্য প্রস্তুত`"
  >
    <div class="off">
      <ErrorNotice v-if="failure" :code="failure.code" :message="failure.message" />

      <AppCard title="This computer" subtitle-bn="এই কম্পিউটার">

        <p v-if="state === 'OFFLINE_SETUP_READY'" class="off__banner ready">
          <strong>Offline setup ready.</strong>
          This computer has passed every check and is the shop's approved offline computer.
          Working without internet is switched on in the next update — the setup is done, the
          till still needs the internet today.
          <span class="label-bn">
            সেটআপ শেষ। ইন্টারনেট ছাড়া বেচাকেনা পরের আপডেটে চালু হবে।
          </span>
        </p>

        <p v-else-if="blockedAt !== null" class="off__banner blocked">
          <strong>{{ GATE_STEPS[blockedAt].whenBlocked }}</strong>
          <span class="label-bn">{{ GATE_STEPS[blockedAt].whenBlockedBn }}</span>
        </p>

        <ol class="off__steps">
          <li v-for="entry in steps" :key="entry.step" :class="{ done: entry.passed, blocker: entry.isBlocker }">
            <i :class="entry.passed ? 'pi pi-check-circle' : 'pi pi-circle'" aria-hidden="true" />
            <span class="off__step-text">
              <strong>{{ entry.copy.title }}</strong>
              <small class="label-bn">{{ entry.copy.titleBn }}</small>
              <small v-if="entry.step === 'STORAGE_SPACE'" class="off__space">{{ spaceLine }}</small>
            </span>
          </li>
        </ol>

        <div class="off__actions">
          <button
            v-if="thisDevice === null && status?.canRegister"
            type="button"
            class="btn btn-primary"
            :disabled="busy"
            @click="registering = true"
          >
            Register this computer <span class="label-bn">এই কম্পিউটার নিবন্ধন করুন</span>
          </button>

          <button
            v-else-if="blockedAt !== null && GATE_STEPS[blockedAt].action !== null"
            type="button"
            class="btn btn-primary"
            :disabled="busy || (blockedAt === 'PWA_INSTALLED' && !installAvailable)"
            @click="fixBlocker"
          >
            <template v-if="blockedAt === 'PWA_INSTALLED'">
              Install the app <span class="label-bn">{{ OFFLINE_BN.install }}</span>
            </template>
            <template v-else-if="blockedAt === 'STORAGE_PERSISTED'">
              Allow permanent storage <span class="label-bn">{{ OFFLINE_BN.allowStorage }}</span>
            </template>
            <template v-else-if="blockedAt === 'DEVICE_AUTHORIZED'">
              Ask to be the offline computer <span class="label-bn">{{ OFFLINE_BN.askPermission }}</span>
            </template>
            <template v-else>Check again <span class="label-bn">আবার দেখুন</span></template>
          </button>

          <button type="button" class="btn btn-ghost" :disabled="busy" @click="load">
            Check again <span class="label-bn">আবার দেখুন</span>
          </button>

          <RouterLink v-if="canRunStorageCheck" class="btn btn-ghost" to="/settings/offline/storage-check">
            Storage check <span class="label-bn">জায়গার পরীক্ষা</span>
          </RouterLink>
        </div>

        <p v-if="thisDevice !== null" class="off__note">
          Registered as <strong>{{ thisDevice.name }}</strong> ·
          {{ statusText(thisDevice).label }}
          <span v-if="thisDevice.status === 'PENDING'">
            — waiting for the owner or manager to approve it.
          </span>
        </p>
        <p v-if="blockedAt === 'PWA_INSTALLED' && !installAvailable" class="off__note">
          This browser is not offering to install the app right now. Open SherERP a few times, or
          use the browser menu’s own <em>Install</em> item.
        </p>
      </AppCard>

      <!--
        Phase 18.3 (owner decision 2026-09-03) — Settings had three doors onto
        one subject: Offline, Sync, and the storage check. They are one door
        now. Sync has lost its sidebar entry and lives here, because "what is
        still waiting to be sent" is a fact about *this machine's* outage, which
        is what the rest of this page is about; `/sync` stays a real route so
        every bookmark and every support call that names it still works.

        The counts come from the sync client the top-bar chip already reads, so
        this card and that chip cannot disagree.
      -->
      <AppCard
        v-if="canSeeSync"
        title="Waiting to be sent"
        subtitle-bn="সিংক — কী কী এখনো পাঠানো হয়নি"
        icon="pi-sync"
      >
        <template #actions>
          <RouterLink class="btn btn-ghost" to="/sync">
            Open sync <span class="label-bn">সিংক খুলুন</span>
          </RouterLink>
        </template>

        <p v-if="sync.pending.value === 0 && sync.refused.value === 0" class="off__note">
          Nothing is waiting. Everything this computer recorded has reached the shop's books.
          <span class="label-bn">সব পাঠানো হয়ে গেছে</span>
        </p>

        <p v-else class="off__note">
          <strong>{{ sync.pending.value }}</strong> waiting to be sent<template
            v-if="sync.refused.value > 0"
          >, and <strong>{{ sync.refused.value }}</strong> the books would not accept</template>.
          <span class="label-bn">
            {{ sync.refused.value > 0 ? 'কিছু ঢোকেনি — দেখে ঠিক করতে হবে' : 'পাঠানো হচ্ছে' }}
          </span>
        </p>
      </AppCard>

      <!--
        Phase 12.3 — the copy of the shop's data on this machine.
        Only on the machine that holds the shop's offline authority: the other
        five computers in a shop are ordinary online machines and there is
        nothing here for them to see.
      -->
      <AppCard
        v-if="holdsOfflineAuthority"
        title="The shop’s data on this computer"
        :subtitle-bn="SNAPSHOT_BN.card"
      >
        <p class="off__lede">
          A copy of the products and the customer, supplier and vendor lists is kept on this
          computer, so the lookup screens still open when the internet is down. It refreshes
          itself once a day.
        </p>

        <p v-if="snapshot === null" class="off__note">
          {{ SNAPSHOT_BN.none }} — no copy has been stored yet.
        </p>

        <dl v-else class="snap">
          <div>
            <dt>Last synced</dt>
            <dd>
              {{ snapshotTakenAt }}
              <span v-if="snapshotAge !== null && snapshotAge >= 1" :class="{ warn: snapshotStale }">
                ({{ snapshotAge }} {{ snapshotAge === 1 ? 'day' : 'days' }} ago)
              </span>
            </dd>
          </div>
          <div>
            <dt>Refreshed by</dt>
            <dd>{{ snapshot.takenByName }}</dd>
          </div>
          <!--
            What the copy holds, and therefore what it does not. The snapshot is
            built with the permissions of whoever refreshed it, so a cashier's
            refresh brings the catalogue and the customers and leaves the
            suppliers out. Printing it is what stops an Owner concluding the
            feature is broken when it is doing exactly what it was told.
          -->
          <div>
            <dt>Holds</dt>
            <dd>{{ snapshotHolds }}</dd>
          </div>
          <!--
            The O-6 numbers (owner direction 2026-08-31): record what the copy
            really costs on the shop's own hardware, impose no fixed ceiling,
            and let real machines settle the open item.
          -->
          <div>
            <dt>Size on this computer</dt>
            <dd>{{ bytesText(snapshotBytes) }}</dd>
          </div>
          <div v-if="thisDevice?.snapshotQuotaBytes != null">
            <dt>Room this browser allows</dt>
            <dd>
              {{ bytesText(thisDevice.snapshotQuotaBytes) }}
              <span class="muted">
                · using {{ bytesText(thisDevice.snapshotUsageBytes) }}
              </span>
            </dd>
          </div>
        </dl>

        <ErrorNotice
          v-if="snapshotFailure !== null"
          code="SNAPSHOT_FAILED"
          :message="snapshotFailure"
        />

        <div class="off__actions">
          <button
            type="button"
            class="btn btn-ghost"
            :disabled="snapshotBusy"
            @click="refreshSnapshotNow"
          >
            {{ snapshotFailure === null ? 'Refresh now' : 'Try again' }}
            <span class="label-bn">
              {{ snapshotFailure === null ? SNAPSHOT_BN.refresh : SNAPSHOT_BN.retry }}
            </span>
          </button>
        </div>

        <!--
          The disclosure the owner asked for on 2026-08-31: no browser-key
          encryption pretending to be protection, and the shop told plainly
          where its data now sits so the machine can be chosen accordingly.
        -->
        <p class="off__note">
          The shop’s data is stored on this computer. It is not encrypted by SherERP — use a
          computer you trust, and switch on the operating system’s own disk encryption.
        </p>
      </AppCard>

      <AppCard v-if="canApprove" title="The shop’s computers" subtitle-bn="দোকানের কম্পিউটারগুলো">

        <p class="off__lede">
          Only one computer at a time may work offline. Approving a second one moves the
          permission — it is never held by two.
        </p>

        <EmptyState
          v-if="!loading && devices.length === 0"
          icon="pi-desktop"
          title="No computer has registered yet"
        >
          A computer appears here once somebody signs in on it and registers it.
        </EmptyState>

        <table v-else class="off__table">
          <thead>
            <tr>
              <th>Computer <small>কম্পিউটার</small></th>
              <th>Status <small>অবস্থা</small></th>
              <th>Last seen <small>শেষ দেখা</small></th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="device in devices" :key="device.id">
              <td>
                <strong>{{ device.name }}</strong>
                <small>{{ device.platform }}</small>
                <small v-if="device.isThisDevice" class="off__this">this computer — এই কম্পিউটার</small>
              </td>
              <td>
                <Tag :value="`${statusText(device).label} · ${statusText(device).bn}`" :severity="statusText(device).tone" />
                <small v-if="device.revokeReason" class="off__reason">{{ device.revokeReason }}</small>
              </td>
              <td>
                {{ when(device.lastSeenAt) }}
                <small v-if="device.approvedByName">approved by {{ device.approvedByName }}</small>
              </td>
              <td class="off__row-actions">
                <button
                  v-if="device.status === 'PENDING' && slotHolder === null"
                  type="button"
                  class="btn btn-primary"
                  :disabled="busy"
                  @click="approving = device"
                >
                  Approve
                </button>
                <button
                  v-else-if="device.status === 'PENDING' && slotHolder !== null"
                  type="button"
                  class="btn btn-primary"
                  :disabled="busy"
                  @click="replacing = device"
                >
                  Replace writer
                </button>
                <button
                  v-if="device.status === 'ACTIVE' && status?.canRevoke"
                  type="button"
                  class="btn btn-ghost"
                  :disabled="busy"
                  @click="revoke(device)"
                >
                  Take permission back
                </button>
                <button
                  v-if="(device.status === 'ACTIVE' || device.status === 'DRAINING') && canForce"
                  type="button"
                  class="btn btn-danger"
                  :disabled="busy"
                  @click="forcing = device"
                >
                  Cut off
                </button>
                <button
                  v-if="status?.canRename"
                  type="button"
                  class="btn btn-ghost"
                  :disabled="busy"
                  @click="renaming = device"
                >
                  Rename
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </AppCard>
    </div>

    <DeviceNameDialog
      v-if="registering"
      title="Register this computer"
      title-bn="এই কম্পিউটার নিবন্ধন করুন"
      lede="This tells the shop which machine you are on. It does not let it work offline yet — an owner or manager approves that separately."
      confirm-label="Register"
      :initial-name="suggestedDeviceName()"
      :busy="busy"
      @close="registering = false"
      @submit="register"
    />

    <DeviceNameDialog
      v-if="approving"
      title="Approve the offline computer"
      title-bn="অফলাইন কম্পিউটার অনুমোদন করুন"
      lede="This computer becomes the shop's one offline computer. No other computer can hold it at the same time."
      confirm-label="Approve"
      :initial-name="approving.name"
      :busy="busy"
      @close="approving = null"
      @submit="approve"
    />

    <DeviceNameDialog
      v-if="renaming"
      title="Rename this computer"
      title-bn="কম্পিউটারের নাম বদলান"
      lede="Only the name changes. Nothing about what this computer may do changes."
      confirm-label="Save name"
      :initial-name="renaming.name"
      :busy="busy"
      @close="renaming = null"
      @submit="rename"
    />

    <ForceRevokeDialog
      v-if="forcing"
      :device="forcing"
      :busy="busy"
      @close="forcing = null"
      @submit="cutOff"
    />

    <ReplaceWriterDialog
      v-if="replacing && slotHolder"
      :incoming="replacing"
      :current="slotHolder"
      :can-force="canForce"
      :busy="busy"
      @close="replacing = null"
      @submit="handOver"
    />
      <OfflineBackupCard />
  </AppShell>
</template>

<style scoped>
.off {
  display: grid;
  gap: var(--sher-space-4);
}

.off__banner {
  margin: 0 0 var(--sher-space-3);
  padding: var(--sher-space-3);
  border: var(--sher-border-w) solid var(--sher-line);
  border-radius: var(--sher-radius);
}

.off__banner .label-bn {
  display: block;
  margin-top: 4px;
}

.off__banner.ready {
  border-color: var(--sher-success, #1e8449);
}

.off__banner.blocked {
  border-color: var(--sher-warning, #b7791f);
}

.off__steps {
  display: grid;
  gap: var(--sher-space-2);
  margin: 0 0 var(--sher-space-3);
  padding: 0;
  list-style: none;
}

.off__steps li {
  display: flex;
  gap: var(--sher-space-2);
  align-items: flex-start;
  color: var(--sher-text-muted);
}

.off__steps li.done {
  color: inherit;
}

.off__steps li.done i {
  color: var(--sher-success, #1e8449);
}

.off__steps li.blocker i {
  color: var(--sher-warning, #b7791f);
}

.off__step-text {
  display: grid;
}

.off__space {
  font-variant-numeric: tabular-nums;
}

.off__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sher-space-2);
  align-items: center;
}

.off__note,
.off__lede {
  margin: var(--sher-space-3) 0 0;
  color: var(--sher-text-muted);
}

.off__lede {
  margin: 0 0 var(--sher-space-3);
}

.off__table {
  width: 100%;
  border-collapse: collapse;
}

.off__table th,
.off__table td {
  padding: var(--sher-space-2);
  border-bottom: var(--sher-border-w) solid var(--sher-line);
  text-align: left;
  vertical-align: top;
}

.off__table small {
  display: block;
  color: var(--sher-text-muted);
  font-size: 11px;
}

.off__this {
  color: var(--sher-primary);
}

.off__row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sher-space-2);
}
</style>
