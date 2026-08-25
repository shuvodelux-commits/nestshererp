<script setup lang="ts">
import type { PermissionDescriptorResponse, RoleDetailResponse } from '@sher/core-contracts';
import { computed, onMounted, ref } from 'vue';

import { createRole, deleteRole, fetchRoles, updateRole } from '../api/roles';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import StatCard from '../components/StatCard.vue';

/**
 * Roles and what they may do (slice 1.4, §5.26).
 *
 * Each role is a card with tick-boxes. Owner's are ticked and frozen: §5.26
 * says it "cannot be deleted or de-privileged", and a shop that could unpick
 * its own Owner would lock itself out permanently.
 *
 * Saving asks for your own password — changing a role re-privileges everyone
 * holding it at once. The server decides whether the password is right.
 *
 * **The tick-boxes are few on purpose.** They cover only what SherERP can do
 * today. Selling, stock, purchases and reports have no permissions yet because
 * those modules do not exist; each arrives with its own, and this screen grows
 * without changing.
 */
const session = useSession();

/**
 * UI-09: a control the caller cannot use is not rendered. Seeing roles and
 * changing them are separate permissions, so a Manager can read this screen
 * without being shown buttons that would refuse them.
 *
 * The server enforces regardless — this only decides what to offer.
 */
const canManage = computed(() => session.can('user.role.manage'));

const loading = ref(true);
const loadError = ref<{ code: string; message: string } | null>(null);
const roles = ref<RoleDetailResponse[]>([]);
const catalogue = ref<PermissionDescriptorResponse[]>([]);
const notice = ref<string | null>(null);

const busy = ref(false);
const formError = ref<{ code: string; message: string } | null>(null);

/** The role being edited, and the ticks as they stand in the form. */
const editing = ref<RoleDetailResponse | null>(null);
const draftName = ref('');
const draftPermissions = ref<string[]>([]);
const confirmPassword = ref('');

/** The new-role dialog, kept separate so a half-typed edit is never confused with it. */
const creating = ref(false);

const deleting = ref<RoleDetailResponse | null>(null);
const deletePassword = ref('');

const groups = computed(() => {
  const seen = new Map<string, PermissionDescriptorResponse[]>();
  for (const entry of catalogue.value) {
    const bucket = seen.get(entry.group) ?? [];
    bucket.push(entry);
    seen.set(entry.group, bucket);
  }
  return [...seen.entries()].map(([name, permissions]) => ({ name, permissions }));
});

/**
 * UI-23's summary tiles, counted from the roles this screen already loaded —
 * never a second source that could disagree with the cards below.
 */
const peopleCovered = computed(() =>
  roles.value.reduce((total, role) => total + role.userCount, 0),
);
const customCount = computed(() => roles.value.filter((role) => !role.isSystem).length);

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const result = await fetchRoles(session.accessToken.value ?? '');
    roles.value = [...result.roles];
    catalogue.value = [...result.catalogue];
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function labelFor(code: string): string {
  return catalogue.value.find((entry) => entry.code === code)?.label ?? code;
}

function openEdit(role: RoleDetailResponse): void {
  editing.value = role;
  creating.value = false;
  draftName.value = role.name;
  draftPermissions.value = [...role.permissions];
  confirmPassword.value = '';
  formError.value = null;
}

function openCreate(): void {
  creating.value = true;
  editing.value = null;
  draftName.value = '';
  draftPermissions.value = [];
  confirmPassword.value = '';
  formError.value = null;
}

function close(): void {
  editing.value = null;
  creating.value = false;
  confirmPassword.value = '';
}

function toggle(code: string): void {
  const at = draftPermissions.value.indexOf(code);
  if (at === -1) draftPermissions.value.push(code);
  else draftPermissions.value.splice(at, 1);
}

const canSave = computed(
  () => !busy.value && draftName.value.trim().length >= 2 && confirmPassword.value !== '',
);

async function save(): Promise<void> {
  busy.value = true;
  formError.value = null;
  try {
    if (creating.value) {
      const created = await createRole(session.accessToken.value ?? '', {
        name: draftName.value.trim(),
        permissions: draftPermissions.value,
        // A new role starts unlimited; the caps get their own control in the
        // Phase 7 Roles pass.
        cashRefundPerReturnMinor: null,
        cashRefundPerDayMinor: null,
        confirmPassword: confirmPassword.value,
      });
      notice.value = `${created.name} was created.`;
    } else if (editing.value !== null) {
      const saved = await updateRole(session.accessToken.value ?? '', editing.value.id, {
        name: draftName.value.trim(),
        permissions: draftPermissions.value,
        // Carried back as they are: this form has no control for them yet, and
        // sending null would quietly remove the Cashier's refund limit the first
        // time anybody renamed the role.
        cashRefundPerReturnMinor: editing.value.cashRefundPerReturnMinor,
        cashRefundPerDayMinor: editing.value.cashRefundPerDayMinor,
        confirmPassword: confirmPassword.value,
      });
      notice.value = `${saved.name} was updated. Everyone holding it is affected straight away.`;
    }
    close();
    await load();
  } catch (cause) {
    formError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

function askToDelete(role: RoleDetailResponse): void {
  deleting.value = role;
  deletePassword.value = '';
  formError.value = null;
}

async function confirmDelete(): Promise<void> {
  const role = deleting.value;
  if (role === null) return;

  busy.value = true;
  formError.value = null;
  try {
    await deleteRole(session.accessToken.value ?? '', role.id, deletePassword.value);
    notice.value = `${role.name} was deleted.`;
    deleting.value = null;
    await load();
  } catch (cause) {
    formError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}
</script>


<template>
  <AppShell
    title="Roles &amp; Permissions"
    :breadcrumb="['Dashboard', 'Roles & Permissions']"
    help-bn="কোন পদের মানুষ কী কী করতে পারবে — এখানে ঠিক করুন"
  >
    <template #actions>
      <button v-if="canManage" type="button" class="btn btn-primary" @click="openCreate">
        <i class="pi pi-plus" aria-hidden="true" />
        Add role
      </button>
    </template>

    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading roles">
      <div class="skeleton skeleton-tiles" />
      <div class="skeleton skeleton-grid" />
    </div>

    <AppCard v-else-if="loadError !== null" title="Could not load your roles">
      <ErrorNotice :code="loadError.code" :message="loadError.message" />
      <button type="button" class="btn btn-ghost retry" @click="load">Try again</button>
    </AppCard>

    <template v-else>
      <p v-if="notice !== null" class="notice is-ok" role="status">{{ notice }}</p>

      <!-- Counted from the roles already on screen (UI-23). -->
      <div class="tiles">
        <StatCard
          label="Roles"
          :value="String(roles.length)"
          detail="Positions in this business"
          icon="pi-shield"
          tone="blue"
        />
        <StatCard
          label="People covered"
          :value="String(peopleCovered)"
          detail="Accounts holding a role"
          icon="pi-users"
          tone="green"
        />
        <StatCard
          label="Your own roles"
          :value="String(customCount)"
          detail="Added by this business"
          icon="pi-pencil"
          tone="violet"
        />
      </div>

      <div class="grid">
        <section v-for="role in roles" :key="role.id" class="role">
          <header>
            <span class="role-mark" aria-hidden="true">
              <i class="pi" :class="role.locked ? 'pi-crown' : 'pi-shield'" />
            </span>
            <div class="role-head-text">
              <h2>{{ role.name }}</h2>
              <p class="held">
                {{ role.userCount }}
                {{ role.userCount === 1 ? 'person holds this' : 'people hold this' }}
              </p>
            </div>
            <span v-if="role.locked" class="pill pill-info">Always full access</span>
            <span v-else-if="role.isSystem" class="pill">Built in</span>
          </header>

          <ul v-if="role.permissions.length > 0" class="perms">
            <li v-for="code in role.permissions" :key="code">
              <i class="pi pi-check" aria-hidden="true" />
              {{ labelFor(code) }}
            </li>
          </ul>
          <p v-else class="perms-empty">Cannot do anything yet.</p>

          <div v-if="canManage" class="role-actions">
            <button type="button" class="linkish" @click="openEdit(role)">
              {{ role.locked ? 'Rename' : 'Edit' }}
            </button>
            <button
              v-if="!role.isSystem"
              type="button"
              class="linkish danger"
              @click="askToDelete(role)"
            >
              Delete
            </button>
          </div>
        </section>
      </div>

      <p v-if="!canManage" class="fine">
        You can see what each role may do, but not change it. Ask the business
        owner if a role needs adjusting.
      </p>
      <p class="fine">
        These are the only things SherERP can do so far. Selling, stock,
        purchases and reports each bring their own permissions as they are
        built, and will appear here automatically.
      </p>
    </template>

    <!-- ------------------------------------------------- add / edit dialog -->
    <div v-if="creating || editing !== null" class="scrim" @click.self="close">
      <div class="dialog is-wide" role="dialog" aria-modal="true">
        <h2>{{ creating ? 'Add role' : `Edit ${editing?.name ?? ''}` }}</h2>

        <form @submit.prevent="save">
          <ErrorNotice v-if="formError !== null" :code="formError.code" :message="formError.message" />

          <div class="field">
            <label for="role-name">Role name</label>
            <input id="role-name" v-model="draftName" type="text" required :disabled="busy" />
          </div>

          <p v-if="editing?.locked === true" class="locked-note">
            The Owner role always keeps every permission, so it can never be
            locked out of its own business. You can rename it.
          </p>

          <fieldset v-else class="perms-field">
            <legend>What this role may do</legend>
            <div v-for="group in groups" :key="group.name" class="group">
              <p class="group-name">{{ group.name }}</p>
              <label v-for="entry in group.permissions" :key="entry.code" class="check">
                <input
                  type="checkbox"
                  :checked="draftPermissions.includes(entry.code)"
                  :disabled="busy"
                  @change="toggle(entry.code)"
                />
                <span>
                  <strong>{{ entry.label }}</strong>
                  <em>{{ entry.detail }}</em>
                </span>
              </label>
            </div>
          </fieldset>

          <div class="field">
            <label for="role-confirm">Your password</label>
            <input
              id="role-confirm"
              v-model="confirmPassword"
              type="password"
              autocomplete="current-password"
              required
              :disabled="busy"
            />
            <p class="sher-bn">এই পরিবর্তন সবার উপর প্রভাব ফেলবে — তাই নিজের পাসওয়ার্ড দিন</p>
          </div>

          <div class="dialog-actions">
            <button type="button" class="btn btn-ghost" :disabled="busy" @click="close">
              Cancel
            </button>
            <button type="submit" class="btn btn-primary" :disabled="!canSave">
              {{ busy ? 'Saving…' : creating ? 'Add role' : 'Save changes' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- ------------------------------------------------------ delete dialog -->
    <div v-if="deleting !== null" class="scrim" @click.self="deleting = null">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>Delete {{ deleting.name }}?</h2>
        <p class="lede">
          This role will stop being offered when adding or editing someone.
          Nothing anyone recorded is removed.
        </p>

        <form @submit.prevent="confirmDelete">
          <ErrorNotice v-if="formError !== null" :code="formError.code" :message="formError.message" />

          <div class="field">
            <label for="delete-confirm">Your password</label>
            <input
              id="delete-confirm"
              v-model="deletePassword"
              type="password"
              autocomplete="current-password"
              required
              :disabled="busy"
            />
          </div>

          <div class="dialog-actions">
            <button type="button" class="btn btn-ghost" :disabled="busy" @click="deleting = null">
              Cancel
            </button>
            <button
              type="submit"
              class="btn btn-danger"
              :disabled="busy || deletePassword === ''"
            >
              {{ busy ? 'Deleting…' : 'Delete role' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
/*
 * Buttons, fields, badges, dialogs and notices come from
 * `design/components.css`. Only the role card and its permission list are
 * this screen's own.
 */
.skeletons {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
}

.skeleton-tiles {
  height: 118px;
}

.skeleton-grid {
  height: 300px;
}

.retry {
  margin-top: var(--sher-space-4);
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--sher-space-4);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: var(--sher-space-4);
}

.role {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-3);
  padding: var(--sher-card-pad);
  background: var(--sher-raised);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-lg);
  box-shadow: var(--sher-shadow-card);
}

.role header {
  display: flex;
  align-items: flex-start;
  gap: var(--sher-space-3);
}

.role-mark {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--sher-radius);
  background: var(--sher-primary-soft);
  color: var(--sher-primary-text);
  font-size: var(--sher-text-lg);
}

.role-head-text {
  min-width: 0;
}

.role h2 {
  margin: 0;
  font-size: var(--sher-text-lg);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.held {
  margin: 2px 0 0;
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
}

.role header .pill {
  margin-left: auto;
}

.perms {
  list-style: none;
  margin: 0;
  padding: var(--sher-space-3) 0 0;
  border-top: 1px solid var(--sher-line-soft);
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.perms li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--sher-text-sm);
}

.perms .pi {
  font-size: var(--sher-text-xs);
  color: var(--sher-ok);
}

.perms-empty {
  margin: 0;
  padding-top: var(--sher-space-3);
  border-top: 1px solid var(--sher-line-soft);
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
}

.role-actions {
  margin-top: auto;
  padding-top: var(--sher-space-3);
  border-top: 1px solid var(--sher-line-soft);
  display: flex;
  gap: var(--sher-space-4);
}

/* --- the permission picker ---------------------------------------------- */
/* Wider than a confirmation, because a tick-box list two columns narrow is
   how a role gets mis-set. */
.dialog.is-wide {
  max-width: 520px;
}

.perms-field {
  margin: 0;
  padding: var(--sher-space-3) var(--sher-space-4) var(--sher-space-4);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-sunken);
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
}

.perms-field legend {
  padding: 0 6px;
  font-size: var(--sher-text-sm);
  font-weight: 600;
}

.group-name {
  margin: 0 0 8px;
  font-size: var(--sher-text-2xs);
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--sher-text-muted);
  font-weight: 600;
}

.check {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 0;
  cursor: pointer;
}

.check input {
  margin-top: 3px;
  accent-color: var(--sher-primary);
  width: 16px;
  height: 16px;
}

.check span {
  display: flex;
  flex-direction: column;
  line-height: 1.4;
}

.check strong {
  font-size: var(--sher-text-sm);
  font-weight: 600;
}

.check em {
  font-style: normal;
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
}

.locked-note {
  margin: 0;
  padding: 11px 14px;
  border: 1px solid var(--sher-info-line);
  border-radius: var(--sher-radius);
  background: var(--sher-info-bg);
  font-size: var(--sher-text-sm);
}
</style>
