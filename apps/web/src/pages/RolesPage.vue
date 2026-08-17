<script setup lang="ts">
import type { PermissionDescriptorResponse, RoleDetailResponse } from '@sher/core-contracts';
import { computed, onMounted, ref } from 'vue';

import { createRole, deleteRole, fetchRoles, updateRole } from '../api/roles';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import AppShell from '../components/shell/AppShell.vue';

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
        confirmPassword: confirmPassword.value,
      });
      notice.value = `${created.name} was created.`;
    } else if (editing.value !== null) {
      const saved = await updateRole(session.accessToken.value ?? '', editing.value.id, {
        name: draftName.value.trim(),
        permissions: draftPermissions.value,
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
  <AppShell title="Roles" help-bn="কোন পদের মানুষ কী কী করতে পারবে — এখানে ঠিক করুন">
    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading roles">
      <div class="skeleton" />
      <div class="skeleton" />
    </div>

    <AppCard v-else-if="loadError !== null" title="Could not load your roles">
      <p class="notice is-bad" role="alert">
        <span class="code">{{ loadError.code }}</span>
        {{ loadError.message }}
      </p>
      <button type="button" class="btn btn-primary" @click="load">Try again</button>
    </AppCard>

    <template v-else>
      <p v-if="notice !== null" class="notice is-ok" role="status">{{ notice }}</p>

      <div class="bar">
        <p class="count">{{ roles.length }} roles</p>
        <button type="button" class="btn btn-primary" @click="openCreate">Add role</button>
      </div>

      <div class="grid">
        <section v-for="role in roles" :key="role.id" class="role">
          <header>
            <h2>{{ role.name }}</h2>
            <span v-if="role.locked" class="pill">Always full access</span>
            <span v-else-if="role.isSystem" class="pill">Built in</span>
          </header>

          <p class="held">
            {{ role.userCount }}
            {{ role.userCount === 1 ? 'person holds this' : 'people hold this' }}
          </p>

          <ul v-if="role.permissions.length > 0" class="perms">
            <li v-for="code in role.permissions" :key="code">{{ labelFor(code) }}</li>
          </ul>
          <p v-else class="perms-empty">Cannot do anything yet.</p>

          <div class="role-actions">
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

      <p class="fine">
        These are the only things SherERP can do so far. Selling, stock,
        purchases and reports each bring their own permissions as they are
        built, and will appear here automatically.
      </p>
    </template>

    <!-- ------------------------------------------------- add / edit dialog -->
    <div v-if="creating || editing !== null" class="scrim" @click.self="close">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>{{ creating ? 'Add role' : `Edit ${editing?.name ?? ''}` }}</h2>

        <form @submit.prevent="save">
          <p v-if="formError !== null" class="notice is-bad" role="alert">
            <span class="code">{{ formError.code }}</span>
            {{ formError.message }}
          </p>

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
          <p v-if="formError !== null" class="notice is-bad" role="alert">
            <span class="code">{{ formError.code }}</span>
            {{ formError.message }}
          </p>

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
              class="btn btn-primary"
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
.skeletons {
  display: grid;
  gap: var(--sher-space-5);
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}

.skeleton {
  height: 180px;
  border-radius: var(--sher-radius-lg);
  border: 1px solid var(--sher-line);
  background: linear-gradient(
    100deg,
    var(--sher-surface-3) 30%,
    var(--sher-surface-2) 50%,
    var(--sher-surface-3) 70%
  );
  background-size: 200% 100%;
  animation: shimmer 1.4s ease-in-out infinite;
}

@keyframes shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sher-space-4);
}

.count {
  margin: 0;
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
}

.grid {
  display: grid;
  gap: var(--sher-space-4);
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
}

.role {
  background: var(--sher-surface-3);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-lg);
  padding: var(--sher-space-4);
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-2);
}

.role header {
  display: flex;
  align-items: center;
  gap: var(--sher-space-2);
  flex-wrap: wrap;
}

.role h2 {
  margin: 0;
  font-size: var(--sher-text-lg);
  font-weight: 600;
}

.pill {
  font-size: var(--sher-text-2xs);
  font-weight: 600;
  padding: 1px 8px;
  border-radius: var(--sher-radius-pill);
  border: 1px solid var(--sher-line);
  background: var(--sher-surface-2);
  color: var(--sher-text-muted);
  white-space: nowrap;
}

.held {
  margin: 0;
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
}

.perms {
  margin: 0;
  padding-left: 18px;
  font-size: var(--sher-text-sm);
  color: var(--sher-text);
}

.perms li {
  padding: 1px 0;
}

.perms-empty {
  margin: 0;
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
  font-style: italic;
}

.role-actions {
  margin-top: auto;
  padding-top: var(--sher-space-2);
  display: flex;
  gap: var(--sher-space-3);
}

.linkish {
  border: 0;
  background: none;
  padding: 0;
  font: inherit;
  font-size: var(--sher-text-sm);
  color: var(--sher-primary-strong);
  text-decoration: underline;
  cursor: pointer;
}

.linkish.danger {
  color: var(--sher-bad);
}

/* --- dialog -------------------------------------------------------------- */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: var(--sher-space-4);
  background: rgba(31, 36, 41, 0.35);
  overflow-y: auto;
}

.dialog {
  width: 100%;
  max-width: 460px;
  background: var(--sher-surface-3);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius-lg);
  box-shadow: var(--sher-shadow-raised);
  padding: var(--sher-space-5);
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-3);
}

.dialog h2 {
  margin: 0;
  font-size: var(--sher-text-lg);
  font-weight: 600;
}

.lede {
  margin: 0;
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
}

form {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-4);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.field label {
  font-size: var(--sher-text-sm);
  font-weight: 600;
}

.field input {
  height: var(--sher-control-h);
  padding: 0 10px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-surface-3);
  font: inherit;
  font-size: var(--sher-text-base);
  color: var(--sher-text);
}

.field input:focus {
  outline: 2px solid var(--sher-primary);
  outline-offset: 1px;
}

.perms-field {
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  padding: var(--sher-space-3);
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-3);
}

.perms-field legend {
  font-size: var(--sher-text-sm);
  font-weight: 600;
  padding: 0 var(--sher-space-2);
}

.group-name {
  margin: 0 0 var(--sher-space-1);
  font-size: var(--sher-text-2xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sher-text-muted);
  font-weight: 600;
}

.check {
  display: flex;
  align-items: flex-start;
  gap: var(--sher-space-2);
  padding: 4px 0;
  cursor: pointer;
}

.check input {
  margin-top: 3px;
  flex-shrink: 0;
}

.check span {
  display: flex;
  flex-direction: column;
}

.check strong {
  font-size: var(--sher-text-base);
  font-weight: 550;
}

.check em {
  font-style: normal;
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
}

.locked-note {
  margin: 0;
  padding: 9px 11px;
  border-radius: var(--sher-radius);
  border: 1px solid var(--sher-line);
  background: var(--sher-surface-2);
  font-size: var(--sher-text-sm);
  color: var(--sher-text-muted);
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sher-space-3);
}

.btn {
  height: var(--sher-control-h);
  padding: 0 16px;
  border-radius: var(--sher-radius);
  border: 1px solid transparent;
  font: inherit;
  font-size: var(--sher-text-base);
  font-weight: 600;
  cursor: pointer;
}

.btn-primary {
  background: var(--sher-primary);
  color: var(--sher-on-primary);
}

.btn-primary:hover:not(:disabled) {
  background: var(--sher-primary-strong);
}

.btn-ghost {
  background: var(--sher-surface-3);
  color: var(--sher-text);
  border-color: var(--sher-line);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.notice {
  margin: 0;
  padding: 9px 11px;
  border-radius: var(--sher-radius);
  border: 1px solid;
  font-size: var(--sher-text-sm);
}

.is-ok {
  border-color: var(--sher-line);
  background: var(--sher-primary-soft);
  color: var(--sher-text);
}

.is-bad {
  border-color: var(--sher-bad);
  background: var(--sher-bad-bg);
  color: var(--sher-text);
}

.code {
  display: block;
  font-family: var(--sher-font-mono);
  font-size: var(--sher-text-2xs);
  letter-spacing: 0.04em;
  color: var(--sher-bad);
  margin-bottom: 2px;
}

.fine {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: var(--sher-text-muted);
}
</style>
