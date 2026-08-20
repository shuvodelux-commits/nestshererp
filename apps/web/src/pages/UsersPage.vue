<script setup lang="ts">
import type { RoleSummaryResponse, UserResponse } from '@sher/core-contracts';
import Select from 'primevue/select';
import { computed, onMounted, ref } from 'vue';

import { createUser, fetchUsers, setUserDisabled, updateUser } from '../api/users';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';
import StatCard from '../components/StatCard.vue';

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

/**
 * UI-09: only offer what this caller may actually do. Adding, editing and
 * disabling are three separate permissions (§5.26 keeps destructive actions
 * apart), so a role may hold one without the others and the screen shows
 * exactly that much.
 *
 * The server enforces regardless — this only decides what to render.
 */
const canCreate = computed(() => session.can('user.account.create'));
const canEdit = computed(() => session.can('user.account.edit'));
const canDisable = computed(() => session.can('user.account.disable'));
const canDoAnything = computed(() => canCreate.value || canEdit.value || canDisable.value);

const loading = ref(true);
const loadError = ref<{ code: string; message: string } | null>(null);
const users = ref<UserResponse[]>([]);
const roles = ref<RoleSummaryResponse[]>([]);

/**
 * UI-23's summary tiles, counted from the rows this screen already loaded.
 * Nothing is fetched twice, so a tile can never disagree with its table.
 */
const activeCount = computed(
  () => users.value.filter((user) => !user.disabled && user.hasPassword).length,
);
const awaitingCount = computed(
  () => users.value.filter((user) => !user.disabled && !user.hasPassword).length,
);
const disabledCount = computed(() => users.value.filter((user) => user.disabled).length);

/** The initials disc beside a name in the table. */
function initialsOf(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.charAt(0) ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.charAt(0) ?? '') : '';
  return (first + last).toUpperCase() || '—';
}

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
  <AppShell
    title="Users"
    :breadcrumb="['Dashboard', 'Users']"
    help-bn="যারা এই ব্যবসায় কাজ করেন — কে কী করতে পারবে তা এখানে ঠিক হয়"
  >
    <template #actions>
      <button v-if="canCreate" type="button" class="btn btn-primary" @click="openCreate">
        <i class="pi pi-user-plus" aria-hidden="true" />
        Add user
      </button>
    </template>

    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading users">
      <div class="skeleton skeleton-tiles" />
      <div class="skeleton skeleton-table" />
    </div>

    <AppCard v-else-if="loadError !== null" title="Could not load your users">
      <ErrorNotice :code="loadError.code" :message="loadError.message" />
      <button type="button" class="btn btn-ghost retry" @click="load">Try again</button>
    </AppCard>

    <template v-else>
      <p v-if="notice !== null" class="notice is-ok" role="status">{{ notice }}</p>

      <!--
        UI-23: summary figures are cards. These are counted from the rows on
        this screen, not from a second source — a tile that could disagree with
        the table beneath it is worse than no tile.
      -->
      <div class="tiles">
        <StatCard
          label="People"
          :value="String(users.length)"
          detail="Everyone with an account"
          icon="pi-users"
          tone="blue"
        />
        <StatCard
          label="Active"
          :value="String(activeCount)"
          detail="Can sign in today"
          icon="pi-check-circle"
          tone="green"
        />
        <StatCard
          label="Awaiting password"
          :value="String(awaitingCount)"
          detail="Added, not yet set up"
          icon="pi-key"
          tone="amber"
        />
        <StatCard
          label="Disabled"
          :value="String(disabledCount)"
          detail="Blocked from signing in"
          icon="pi-ban"
          tone="rose"
        />
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
              <th v-if="canDoAnything" class="actions-col">Actions</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in users" :key="user.id" :class="{ 'is-disabled': user.disabled }">
              <td>
                <span class="person">
                  <span class="person-mark" aria-hidden="true">{{ initialsOf(user.displayName) }}</span>
                  <span class="person-name">{{ user.displayName }}</span>
                </span>
              </td>
              <td class="mono">{{ user.username }}</td>
              <td class="mono">{{ user.phone ?? user.email }}</td>
              <td>{{ user.roleName }}</td>
              <td>
                <span v-if="user.disabled" class="pill pill-bad">Disabled</span>
                <span v-else-if="!user.hasPassword" class="pill pill-warn">Awaiting password</span>
                <span v-else class="pill pill-ok">Active</span>
              </td>
              <td v-if="canDoAnything" class="actions">
                <button v-if="canEdit" type="button" class="linkish" @click="openEdit(user)">
                  Edit
                </button>
                <button
                  v-if="canDisable"
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

      <p v-if="!canDoAnything" class="fine">
        You can see who works here, but not make changes. Ask the business owner
        to add someone or adjust an account.
      </p>
      <p v-if="canCreate" class="fine">
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
          <ErrorNotice v-if="formError !== null" :code="formError.code" :message="formError.message" />

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
            <Select input-id="role" v-model="roleId" :options="roles" option-label="name" option-value="id" :disabled="busy" fluid />
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
          <ErrorNotice v-if="formError !== null" :code="formError.code" :message="formError.message" />

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
/*
 * Buttons, fields, tables, badges, dialogs, notices and skeletons come from
 * `design/components.css`. What is left here is the two things only this
 * screen has: the tile row and the avatar in the name column.
 */
.skeletons {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
}

.skeleton-tiles {
  height: 118px;
}

.skeleton-table {
  height: 320px;
}

.retry {
  margin-top: var(--sher-space-4);
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--sher-space-4);
}

.person {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.person-mark {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: var(--sher-primary-soft);
  color: var(--sher-primary-text);
  font-size: var(--sher-text-xs);
  font-weight: 700;
}

.person-name {
  font-weight: 600;
}

/* A disabled account still reads, but it stops competing with the active ones. */
tbody tr.is-disabled td:not(.actions) {
  color: var(--sher-text-muted);
}

tbody tr.is-disabled .person-mark {
  background: var(--sher-sunken);
  color: var(--sher-text-faint);
}
</style>
