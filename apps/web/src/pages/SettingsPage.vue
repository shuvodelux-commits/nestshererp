<script setup lang="ts">
import type { SettingDescriptorResponse, SettingsResponse } from '@sher/core-contracts';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';

import { ApiError } from '../api/client';
import { fetchSettings, saveBusinessProfile, saveSetting } from '../api/settings';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * Settings and feature controls (slice 1.5, §5.21).
 *
 * The business profile sits at the top because it is the one change on this
 * screen whose effect the owner can see immediately: rename the business and
 * the sidebar says the new name before the save has finished settling.
 *
 * Below it, every setting §5.21 defines, grouped. Two honesty rules shape how
 * they are drawn:
 *
 *   **UI-09 — never render a control that will 403.** Someone who may read
 *   settings but not change them gets the values as text, not as dead inputs.
 *   Toggling a whole feature is a separate permission from choosing how a
 *   running one behaves, so the two are offered separately.
 *
 *   **A setting whose module does not exist yet says so.** Its value is stored
 *   and audited, and it will be obeyed the day that module ships — but claiming
 *   it is doing something today would be a lie the screen tells every time it
 *   loads. The marker comes from the server's own catalogue (`inEffect`), so it
 *   cannot drift from what the software actually reads.
 */
const session = useSession();

const canEdit = computed(() => session.can('settings.setting.edit'));
const canToggle = computed(() => session.can('settings.module.toggle'));

const loading = ref(true);
const loadError = ref<{ code: string; message: string } | null>(null);
const settings = ref<SettingsResponse | null>(null);

/** What the last save changed beyond what was clicked (§5.21 cascade). */
const notice = ref<string | null>(null);
const formError = ref<{ code: string; message: string } | null>(null);
/** The key currently saving, so only its own row shows a busy state. */
const savingKey = ref<string | null>(null);

/* --- business profile ------------------------------------------------------ */
const draftName = ref('');
const draftTimezone = ref('');
const savingProfile = ref(false);

const profileDirty = computed(
  () =>
    settings.value !== null &&
    (draftName.value.trim() !== settings.value.businessName ||
      draftTimezone.value !== settings.value.timezone),
);

/* --- step-up --------------------------------------------------------------- */
/**
 * §5.3: changing the costing method asks for your own password. Held in a
 * dialog rather than a field beside every control, so the password is typed
 * once, for one specific change, and is never sitting on screen.
 */
const stepUp = ref<{ descriptor: SettingDescriptorResponse; value: string } | null>(null);
const stepUpPassword = ref('');

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

function adopt(next: SettingsResponse): void {
  settings.value = next;
  draftName.value = next.businessName;
  draftTimezone.value = next.timezone;
  // The sidebar reads the business name from the session, so a rename shows
  // there immediately rather than after the next sign-in.
  session.setBusinessName(next.businessName);
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    adopt(await fetchSettings(session.accessToken.value ?? ''));
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** The catalogue in display order, stacked by its own `group`. */
const groups = computed(() => {
  const seen = new Map<string, SettingDescriptorResponse[]>();
  for (const descriptor of settings.value?.catalogue ?? []) {
    const bucket = seen.get(descriptor.group) ?? [];
    bucket.push(descriptor);
    seen.set(descriptor.group, bucket);
  }
  return [...seen.entries()].map(([name, entries]) => ({ name, entries }));
});

function valueOf(descriptor: SettingDescriptorResponse): string {
  return settings.value?.values[descriptor.key] ?? descriptor.defaultValue;
}

function mayChange(descriptor: SettingDescriptorResponse): boolean {
  return descriptor.kind === 'TOGGLE' ? canToggle.value : canEdit.value;
}

/** The parents that are still off, so the row can say why it is not available. */
function blockedBy(descriptor: SettingDescriptorResponse): readonly string[] {
  const catalogue = settings.value?.catalogue ?? [];
  return descriptor.requires
    .filter((key) => (settings.value?.values[key] ?? 'off') !== 'on')
    .map((key) => catalogue.find((entry) => entry.key === key)?.label ?? key);
}

async function apply(descriptor: SettingDescriptorResponse, value: string): Promise<void> {
  if (value === valueOf(descriptor)) return;

  // §5.3 asks for the password before the change, not after it is refused.
  if (descriptor.stepUp) {
    stepUp.value = { descriptor, value };
    stepUpPassword.value = '';
    formError.value = null;
    return;
  }
  await commit(descriptor, value);
}

async function commit(
  descriptor: SettingDescriptorResponse,
  value: string,
  confirmPassword?: string,
): Promise<void> {
  savingKey.value = descriptor.key;
  formError.value = null;
  notice.value = null;
  try {
    const saved = await saveSetting(session.accessToken.value ?? '', {
      key: descriptor.key,
      value,
      ...(confirmPassword === undefined ? {} : { confirmPassword }),
    });
    adopt(saved.settings);
    stepUp.value = null;
    stepUpPassword.value = '';
    notice.value =
      saved.warnings.length === 0
        ? `${descriptor.label} saved.`
        : `${descriptor.label} saved. ${saved.warnings.map((warning) => warning.message).join(' ')}`;
  } catch (cause) {
    formError.value = describe(cause);
  } finally {
    savingKey.value = null;
  }
}

async function confirmStepUp(): Promise<void> {
  const pending = stepUp.value;
  if (pending === null) return;
  await commit(pending.descriptor, pending.value, stepUpPassword.value);
}

async function submitProfile(): Promise<void> {
  savingProfile.value = true;
  formError.value = null;
  notice.value = null;
  try {
    adopt(
      await saveBusinessProfile(session.accessToken.value ?? '', {
        businessName: draftName.value.trim(),
        timezone: draftTimezone.value,
      }),
    );
    notice.value = 'Business details saved.';
  } catch (cause) {
    formError.value = describe(cause);
  } finally {
    savingProfile.value = false;
  }
}
</script>

<template>
  <AppShell
    title="Settings"
    :breadcrumb="['SherERP']"
    help-bn="আপনার ব্যবসার তথ্য ও ফিচার নিয়ন্ত্রণ"
  >
    <div v-if="loading" class="skeleton" role="status" aria-live="polite">Loading settings…</div>

    <ErrorNotice v-else-if="loadError" :code="loadError.code" :message="loadError.message">
      <button type="button" class="btn btn-ghost" @click="load">Try again</button>
    </ErrorNotice>

    <template v-else-if="settings">
      <p v-if="notice" class="notice is-ok" role="status">{{ notice }}</p>
      <ErrorNotice v-if="formError" :code="formError.code" :message="formError.message" />

      <AppCard title="Business" subtitle="The name shown across SherERP, and the day it counts by.">
        <form class="profile" @submit.prevent="submitProfile">
          <div class="field">
            <label for="business-name">Business name</label>
            <input
              id="business-name"
              v-model="draftName"
              type="text"
              autocomplete="organization"
              :disabled="!canEdit || savingProfile"
            />
          </div>

          <div class="field">
            <label for="business-timezone">Timezone</label>
            <Select input-id="business-timezone" v-model="draftTimezone" :options="settings.supportedTimezones" :disabled="!canEdit || savingProfile" filter fluid />
            <p class="help">
              Every report and every day's takings are counted in this timezone.
            </p>
          </div>

          <div v-if="canEdit" class="profile-actions">
            <button
              type="submit"
              class="btn btn-primary"
              :disabled="!profileDirty || savingProfile"
            >
              {{ savingProfile ? 'Saving…' : 'Save' }}
            </button>
          </div>
          <p v-else class="fine">You do not have permission to change these.</p>
        </form>
      </AppCard>

      <AppCard
        v-for="group in groups"
        :key="group.name"
        :title="group.name"
        class="group-card"
      >
        <ul class="settings">
          <li v-for="descriptor in group.entries" :key="descriptor.key" class="setting">
            <div class="setting-text">
              <div class="setting-title">
                <strong>{{ descriptor.label }}</strong>
                <!--
                  Honest about what the software can currently do. The value is
                  saved and audited; the module that reads it is not built yet.
                -->
                <span v-if="!descriptor.inEffect" class="pill pill-info">
                  Takes effect with {{ descriptor.consumedBy }}
                </span>
                <span v-if="descriptor.stepUp" class="pill pill-warn">Asks for your password</span>
              </div>
              <p class="setting-detail">{{ descriptor.detail }}</p>
              <p v-if="blockedBy(descriptor).length > 0" class="fine">
                Needs {{ blockedBy(descriptor).join(' and ') }} turned on first.
              </p>
            </div>

            <div class="setting-control">
              <template v-if="mayChange(descriptor)">
                <Select
                  :input-id="`setting-${descriptor.key}`"
                  :aria-label="descriptor.label"
                  :model-value="valueOf(descriptor)"
                  :options="descriptor.options"
                  :disabled="savingKey === descriptor.key"
                  @update:model-value="apply(descriptor, String($event))"
                >
                  <template #value="slotProps">{{ slotProps.value === 'on' ? 'On' : slotProps.value === 'off' ? 'Off' : slotProps.value }}</template>
                  <template #option="slotProps">{{ slotProps.option === 'on' ? 'On' : slotProps.option === 'off' ? 'Off' : slotProps.option }}</template>
                </Select>
              </template>
              <!--
                UI-09: a control this caller cannot use is not rendered as a
                disabled input. The value is still shown — reading is what their
                permission allows.
              -->
              <span v-else class="pill" :class="valueOf(descriptor) === 'off' ? 'pill' : 'pill-ok'">
                {{ valueOf(descriptor) === 'on' ? 'On' : valueOf(descriptor) === 'off' ? 'Off' : valueOf(descriptor) }}
              </span>
            </div>
          </li>
        </ul>
      </AppCard>
    </template>

    <!-- §5.3 step-up. Asked once, for one change, and never left on screen. -->
    <div v-if="stepUp" class="scrim" @click.self="stepUp = null">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="step-up-title">
        <h2 id="step-up-title">Confirm it is you</h2>
        <p class="lede">
          Changing “{{ stepUp.descriptor.label }}” to {{ stepUp.value }} decides what every sale is
          recorded as costing. Enter your own password to continue.
        </p>

        <form @submit.prevent="confirmStepUp">
          <div class="field">
            <label for="step-up-password">Your password</label>
            <input
              id="step-up-password"
              v-model="stepUpPassword"
              type="password"
              autocomplete="current-password"
            />
          </div>

          <ErrorNotice v-if="formError" :code="formError.code" :message="formError.message" />

          <div class="dialog-actions">
            <button type="button" class="btn btn-ghost" @click="stepUp = null">Cancel</button>
            <button
              type="submit"
              class="btn btn-primary"
              :disabled="stepUpPassword === '' || savingKey !== null"
            >
              {{ savingKey !== null ? 'Saving…' : 'Confirm' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.profile {
  display: grid;
  gap: var(--sher-space-4);
  max-width: 420px;
}

.profile-actions {
  display: flex;
  gap: var(--sher-space-2);
}

.group-card {
  margin-top: var(--sher-space-4);
}

.settings {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.setting {
  display: flex;
  align-items: flex-start;
  gap: var(--sher-space-4);
  padding: var(--sher-space-3) 0;
  border-bottom: 1px solid var(--sher-line);
}

.setting:last-child {
  border-bottom: none;
}

.setting-text {
  min-width: 0;
  flex: 1;
}

.setting-title {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sher-space-2);
}

.setting-detail {
  margin: 4px 0 0;
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
  line-height: 1.55;
}

.setting-control {
  flex-shrink: 0;
  min-width: 140px;
  display: flex;
  justify-content: flex-end;
}

.setting-control select {
  width: 100%;
  height: 38px;
  padding: 0 10px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-raised);
  color: var(--sher-text);
  font: inherit;
  font-size: var(--sher-text-sm);
}

.setting-control select:disabled {
  opacity: 0.6;
}
</style>
