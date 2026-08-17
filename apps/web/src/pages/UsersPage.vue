<script setup lang="ts">
import type { RoleSummaryResponse, UserResponse } from '@sher/core-contracts';
import { computed, onMounted, ref } from 'vue';

import { createUser, fetchUsers, setUserDisabled, updateUser } from '../api/users';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * The people who work in this business (slice 1.3, §5.3).
 *
 * A List screen (UI-22): filter-free for now, because a shop has a handful of
 * staff and a search box over six rows is furniture. It arrives with the row
 * count that needs it.
 *
 * Adding someone, changing their role and disabling them each ask for **your
 * own password**. §5.3 calls these step-up actions; the check happens on the
 * server, and this screen only collects what it needs to.
 *
 * A new user gets no password. They set their own on the sign-in page, through
 * the same screen that resets a forgotten one — it proves they hold the phone
 * or email, so the person who added them never knows their credential.
 */
const session = useSession();

const loading = ref(true);
const loadError = ref<{ code: string; message: string } | null>(null);
const users = ref<UserResponse[]>([]);
const roles = ref<RoleSummaryResponse[]>([]);

/** Which dialog is open, if any. */
type Editing = { mode: 'CREATE' } | { mode: 'EDIT'; user: UserResponse } | null;
const editing = ref<Editing>(null);

const busy = ref(false);
const formError = ref<{ code: string; message: string } | null>(null);
const notice = ref<string | null>(null);

const displayName = ref('');
const username = ref('');
const identifier = ref('');
const roleId = ref('');
const confirmPassword = ref('');

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const result = await fetchUsers(session.accessToken.value ?? '');
    users.value = [...result.users];
    roles.value = [...result.roles];
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function openCreate(): void {
  editing.value = { mode: 'CREATE' };
  formError.value = null;
  displayName.value = '';
  username.value = '';
  identifier.value = '';
  roleId.value = roles.value[0]?.id ?? '';
  confirmPassword.value = '';
}

function openEdit(user: UserResponse): void {
  editing.value = { mode: 'EDIT', user };
  formError.value = null;
  displayName.value = user.displayName;
  username.value = user.username;
  identifier.value = user.phone ?? user.email ?? '';
  roleId.value = user.roleId;
  confirmPassword.value = '';
}

function close(): void {
  editing.value = null;
  confirmPassword.value = '';
}

/** Renaming is not step-up; changing a role is (§5.3). */
const roleIsChanging = computed(
  () => editing.value?.mode === 'EDIT' && editing.value.user.roleId !== roleId.value,
);

const needsPassword = computed(
  () => editing.value?.mode === 'CREATE' || roleIsChanging.value,
);

const canSubmit = computed(() => {
  if (busy.value || displayName.value.trim() === '' || roleId.value === '') return false;
  if (needsPassword.value && confirmPassword.value === '') return false;
  if (editing.value?.mode === 'CREATE') {
    return username.value.trim().length >= 3 && identifier.value.trim() !== '';
  }
  return true;
});

async function submit(): Promise<void> {
  const target = editing.value;
  if (target === null) return;

  busy.value = true;
  formError.value = null;
  try {
    if (target.mode === 'CREATE') {
      const created = await createUser(session.accessToken.value ?? '', {
        displayName: displayName.value.trim(),
        username: username.value.trim(),
        identifier: identifier.value.trim(),
        roleId: roleId.value,
        confirmPassword: confirmPassword.value,
      });
      notice.value = `${created.displayName} was added. Tell them to sign in and choose “First time here? Set your password”.`;
    } else {
      await updateUser(session.accessToken.value ?? '', target.user.id, {
        displayName: displayName.value.trim(),
        roleId: roleId.value,
        ...(roleIsChanging.value ? { confirmPassword: confirmPassword.value } : {}),
      });
      notice.value = 'Changes saved.';
    }
    close();
    await load();
  } catch (cause) {
    formError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

/* --- disable / enable ---------------------------------------------------- */
const confirming = ref<UserResponse | null>(null);
const confirmingPassword = ref('');

function askToToggle(user: UserResponse): void {
  confirming.value = user;
  confirmingPassword.value = '';
  formError.value = null;
}

async function toggleDisabled(): Promise<void> {
  const user = confirming.value;
  if (user === null) return;

  busy.value = true;
  formError.value = null;
  try {
    await setUserDisabled(session.accessToken.value ?? '', user.id, {
      disabled: !user.disabled,
      confirmPassword: confirmingPassword.value,
    });
    notice.value = user.disabled
      ? `${user.displayName} can sign in again.`
      : `${user.displayName} has been disabled and signed out everywhere.`;
    confirming.value = null;
    await load();
  } catch (cause) {
    formError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppShell title="Users" help-bn="যারা এই ব্যবসায় কাজ করেন — কে কী করতে পারবে তা এখানে ঠিক হয়">
    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading users">
      <div class="skeleton" />
    </div>

    <AppCard v-else-if="loadError !== null" title="Could not load your users">
      <p class="notice is-bad" role="alert">
        <span class="code">{{ loadError.code }}</span>
        {{ loadError.message }}
      </p>
      <button type="button" class="btn btn-primary" @click="load">Try again</button>
    </AppCard>

    <template v-else>
      <p v-if="notice !== null" class="notice is-ok" role="status">{{ notice }}</p>

      <div class="bar">
        <p class="count">{{ users.length }} {{ users.length === 1 ? 'person' : 'people' }}</p>
        <button type="button" class="btn btn-primary" @click="openCreate">Add user</button>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Username</th>
              <th>Mobile / email</th>
              <th>Role</th>
              <th>Status</th>
              <th class="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.id" :class="{ 'is-disabled': user.disabled }">
              <td>{{ user.displayName }}</td>
              <td class="mono">{{ user.username }}</td>
              <td class="mono">{{ user.phone ?? user.email }}</td>
              <td>{{ user.roleName }}</td>
              <td>
                <span v-if="user.disabled" class="pill pill-bad">Disabled</span>
                <span v-else-if="!user.hasPassword" class="pill pill-warn">Awaiting password</span>
                <span v-else class="pill pill-ok">Active</span>
              </td>
              <td class="actions">
                <button type="button" class="linkish" @click="openEdit(user)">Edit</button>
                <button
                  type="button"
                  class="linkish"
                  :class="{ danger: !user.disabled }"
                  @click="askToToggle(user)"
                >
                  {{ user.disabled ? 'Enable' : 'Disable' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="fine">
        A new person has no password until they set one themselves — which is
        why you never have to think one up for them. Tell them to open the
        sign-in page and click <strong>“First time here? Set your password”</strong>,
        using the mobile number or email you entered above.
      </p>
    </template>

    <!-- ------------------------------------------------- add / edit dialog -->
    <div v-if="editing !== null" class="scrim" @click.self="close">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>{{ editing.mode === 'CREATE' ? 'Add user' : 'Edit user' }}</h2>

        <form @submit.prevent="submit">
          <p v-if="formError !== null" class="notice is-bad" role="alert">
            <span class="code">{{ formError.code }}</span>
            {{ formError.message }}
          </p>

          <div class="field">
            <label for="display-name">Full name</label>
            <input id="display-name" v-model="displayName" type="text" required :disabled="busy" />
          </div>

          <template v-if="editing.mode === 'CREATE'">
            <div class="field">
              <label for="username">Username</label>
              <input id="username" v-model="username" type="text" required :disabled="busy" />
              <p class="help">At least 3 characters. Used for display and the audit trail.</p>
            </div>

            <div class="field">
              <label for="identifier">Mobile number or email</label>
              <input id="identifier" v-model="identifier" type="text" required :disabled="busy" />
              <p class="sher-bn">এই নম্বরেই তিনি পাসওয়ার্ড সেট করার কোড পাবেন</p>
            </div>
          </template>

          <div class="field">
            <label for="role">Role</label>
            <select id="role" v-model="roleId" :disabled="busy">
              <option v-for="role in roles" :key="role.id" :value="role.id">{{ role.name }}</option>
            </select>
          </div>

          <div v-if="needsPassword" class="field">
            <label for="confirm">Your password</label>
            <input
              id="confirm"
              v-model="confirmPassword"
              type="password"
              autocomplete="current-password"
              required
              :disabled="busy"
            />
            <p class="sher-bn">নিরাপত্তার জন্য নিজের পাসওয়ার্ড দিন</p>
          </div>

          <div class="dialog-actions">
            <button type="button" class="btn btn-ghost" :disabled="busy" @click="close">
              Cancel
            </button>
            <button type="submit" class="btn btn-primary" :disabled="!canSubmit">
              {{ busy ? 'Saving…' : editing.mode === 'CREATE' ? 'Add user' : 'Save changes' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- -------------------------------------------------- disable / enable -->
    <div v-if="confirming !== null" class="scrim" @click.self="confirming = null">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>{{ confirming.disabled ? 'Enable' : 'Disable' }} {{ confirming.displayName }}?</h2>
        <p class="lede">
          <template v-if="confirming.disabled">
            They will be able to sign in again straight away.
          </template>
          <template v-else>
            They will be signed out everywhere and will not be able to sign in.
            Nothing they recorded is removed.
          </template>
        </p>

        <form @submit.prevent="toggleDisabled">
          <p v-if="formError !== null" class="notice is-bad" role="alert">
            <span class="code">{{ formError.code }}</span>
            {{ formError.message }}
          </p>

          <div class="field">
            <label for="confirm-toggle">Your password</label>
            <input
              id="confirm-toggle"
              v-model="confirmingPassword"
              type="password"
              autocomplete="current-password"
              required
              :disabled="busy"
            />
          </div>

          <div class="dialog-actions">
            <button
              type="button"
              class="btn btn-ghost"
              :disabled="busy"
              @click="confirming = null"
            >
              Cancel
            </button>
            <button
              type="submit"
              class="btn btn-primary"
              :disabled="busy || confirmingPassword === ''"
            >
              {{ busy ? 'Saving…' : confirming.disabled ? 'Enable' : 'Disable' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
.skeletons {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
}

.skeleton {
  height: 260px;
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

/*
 * §2.7-D: the container may be a panel, the table stays clean and dense. No
 * translucency behind rows — UI-42's contrast floor cannot spare it.
 */
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-surface-3);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--sher-text-base);
}

thead th {
  text-align: left;
  font-size: var(--sher-text-2xs);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--sher-text-muted);
  font-weight: 600;
  background: var(--sher-surface-2);
  padding: 7px 13px;
  border-bottom: 1px solid var(--sher-line);
  white-space: nowrap;
}

tbody td {
  padding: var(--sher-row-pad);
  border-bottom: 1px solid var(--sher-line-soft);
}

tbody tr:last-child td {
  border-bottom: 0;
}

tbody tr:hover {
  background: var(--sher-primary-soft);
}

tbody tr.is-disabled td:not(.actions) {
  color: var(--sher-text-muted);
}

.mono {
  font-family: var(--sher-font-mono);
  font-size: var(--sher-text-sm);
}

.actions-col {
  width: 1%;
}

.actions {
  white-space: nowrap;
  display: flex;
  gap: var(--sher-space-3);
}

.pill {
  display: inline-block;
  font-size: var(--sher-text-2xs);
  font-weight: 600;
  padding: 1px 8px;
  border-radius: var(--sher-radius-pill);
  border: 1px solid var(--sher-line);
  white-space: nowrap;
}

.pill-ok {
  background: var(--sher-ok-bg);
  color: var(--sher-ok);
  border-color: rgba(31, 122, 77, 0.3);
}

.pill-warn {
  background: var(--sher-warn-bg);
  color: var(--sher-warn);
  border-color: rgba(138, 93, 0, 0.3);
}

.pill-bad {
  background: var(--sher-bad-bg);
  color: var(--sher-bad);
  border-color: rgba(168, 32, 24, 0.3);
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
}

.dialog {
  width: 100%;
  max-width: 400px;
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

.field input,
.field select {
  height: var(--sher-control-h);
  padding: 0 10px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-surface-3);
  font: inherit;
  font-size: var(--sher-text-base);
  color: var(--sher-text);
}

.field input:focus,
.field select:focus {
  outline: 2px solid var(--sher-primary);
  outline-offset: 1px;
}

.field input:disabled,
.field select:disabled {
  background: var(--sher-surface);
}

.help {
  margin: 0;
  font-size: var(--sher-text-xs);
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
