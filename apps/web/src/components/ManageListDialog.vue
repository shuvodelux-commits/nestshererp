<script setup lang="ts">
import type { MenuItem } from 'primevue/menuitem';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Menu from 'primevue/menu';
import Message from 'primevue/message';
import { ref } from 'vue';

import { ApiError } from '../api/client';

interface Entry {
  readonly id: string;
  readonly name: string;
}

const props = defineProps<{
  title: string;
  titleBn?: string | undefined;
  entries: readonly Entry[];
  canEdit: boolean;
  canAdd: boolean;
  addPlaceholder?: string | undefined;
  create: (name: string) => Promise<string>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<string>;
}>();

const emit = defineEmits<{ close: []; created: [id: string] }>();
const visible = ref(true);
const newName = ref('');
const menuFor = ref<string | null>(null);
const editing = ref<string | null>(null);
const draft = ref('');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
const outcome = ref<string | null>(null);
const confirming = ref<Entry | null>(null);

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

async function addEntry(): Promise<void> {
  if (newName.value.trim() === '' || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const id = await props.create(newName.value.trim());
    emit('created', id);
    newName.value = '';
    outcome.value = null;
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

function startEdit(entry: Entry): void {
  menuFor.value = null;
  editing.value = entry.id;
  draft.value = entry.name;
  error.value = null;
}

async function saveEdit(id: string): Promise<void> {
  if (draft.value.trim() === '' || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await props.rename(id, draft.value.trim());
    editing.value = null;
    outcome.value = null;
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

function rowItems(entry: Entry): MenuItem[] {
  return [
    { label: 'Edit', icon: 'pi pi-pencil', command: () => startEdit(entry) },
    {
      label: 'Delete',
      icon: 'pi pi-trash',
      styleClass: 'sher-menu-danger',
      command: () => {
        confirming.value = entry;
        menuFor.value = null;
      },
    },
  ];
}

async function confirmRemove(): Promise<void> {
  const entry = confirming.value;
  if (entry === null || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    outcome.value = await props.remove(entry.id);
    confirming.value = null;
  } catch (cause) {
    error.value = describe(cause);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    v-model:visible="visible"
    class="manage-panel"
    modal
    dismissable-mask
    append-to="self"
    :draggable="false"
    :aria-label="`Manage ${title}`"
    :style="{ width: '30rem' }"
    :breakpoints="{ '640px': 'calc(100vw - 1.5rem)' }"
    @hide="emit('close')"
  >
    <template #header>
      <div class="manage-head">
        <h2>Manage {{ title }}</h2>
        <p v-if="titleBn" class="sher-bn">{{ titleBn }}</p>
      </div>
    </template>

    <Message v-if="error !== null" class="manage-error" severity="error" :closable="false">
      <span>{{ error.message }}</span>
      <small>{{ error.code }}</small>
    </Message>
    <Message v-if="outcome !== null" class="manage-outcome" severity="success" :closable="false">
      {{ outcome }}
    </Message>

    <div v-if="canAdd" class="manage-add">
      <InputText
        v-model="newName"
        :placeholder="addPlaceholder ?? 'New name'"
        :aria-label="`New ${title}`"
        fluid
        @keyup.enter="addEntry"
      />
      <Button label="Add" icon="pi pi-plus" :loading="busy" @click="addEntry" />
    </div>

    <p v-if="entries.length === 0" class="manage-empty">Nothing here yet — add the first one above.</p>

    <ul v-else class="manage-list">
      <li v-for="entry in entries" :key="entry.id">
        <template v-if="editing === entry.id">
          <InputText
            v-model="draft"
            class="manage-input"
            :aria-label="`Rename ${entry.name}`"
            @keyup.enter="saveEdit(entry.id)"
            @keyup.esc="editing = null"
          />
          <Button
            class="manage-save"
            size="small"
            label="Save"
            :loading="busy"
            @click="saveEdit(entry.id)"
          />
          <Button size="small" label="Cancel" severity="secondary" text @click="editing = null" />
        </template>

        <template v-else>
          <span class="manage-name">{{ entry.name }}</span>
          <div v-if="canEdit" class="manage-actions">
            <Button
              v-tooltip.top="'Edit or delete · নাম বদলান বা মুছুন'"
              icon="pi pi-ellipsis-h"
              text
              rounded
              :aria-label="`Actions for ${entry.name}`"
              :aria-expanded="menuFor === entry.id"
              :class="{ 'is-open': menuFor === entry.id }"
              @click="menuFor = menuFor === entry.id ? null : entry.id"
            />
          </div>
          <Menu v-if="menuFor === entry.id" class="manage-menu" :model="rowItems(entry)" />
        </template>
      </li>
    </ul>

    <section v-if="confirming !== null" class="manage-confirm" aria-label="Confirm removal">
      <p>Remove <strong>{{ confirming.name }}</strong>?</p>
      <p class="sher-bn">
        এটি যদি কোনো পণ্যে ব্যবহার হয়ে থাকে, তবে মুছে না গিয়ে শুধু তালিকা থেকে সরে যাবে।
      </p>
      <p class="fine">
        If products already use it, it is archived rather than deleted, so nothing they record
        changes. You will be told which happened.
      </p>
      <div class="manage-confirm-actions">
        <Button label="Cancel" severity="secondary" text @click="confirming = null" />
        <Button
          class="manage-remove"
          label="Remove"
          severity="danger"
          :loading="busy"
          @click="confirmRemove"
        />
      </div>
    </section>
  </Dialog>
</template>

<style scoped>
.manage-head h2 {
  margin: 0;
  font-size: var(--sher-text-lg);
  font-weight: 600;
}

.manage-head p {
  margin: 2px 0 0;
  font-size: var(--sher-text-xs);
  color: var(--sher-text-muted);
}

.manage-error,
.manage-outcome {
  margin-bottom: var(--sher-space-3);
}

.manage-error :deep(.p-message-text) {
  display: flex;
  flex-direction: column;
}

.manage-add {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--sher-space-2);
  margin-bottom: var(--sher-space-3);
  padding-bottom: var(--sher-space-3);
  border-bottom: 1px solid var(--sher-line);
}

.manage-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.manage-list li {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sher-space-2);
  min-height: 52px;
  padding: var(--sher-space-1) 0;
  border-bottom: 1px solid var(--sher-line);
}

.manage-name,
.manage-input {
  flex: 1;
  min-width: 0;
}

.manage-actions :deep(.is-open) {
  background: var(--sher-primary-soft);
  color: var(--sher-primary);
}

.manage-menu {
  width: 100%;
}

.manage-confirm {
  margin-top: var(--sher-space-4);
  padding: var(--sher-space-4);
  border: 1px solid var(--sher-warn-line);
  border-radius: var(--sher-radius);
  background: var(--sher-warn-bg);
}

.manage-confirm p {
  margin: 0 0 var(--sher-space-2);
}

.manage-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sher-space-2);
  margin-top: var(--sher-space-3);
}

.manage-empty,
.fine {
  color: var(--sher-text-muted);
  font-size: var(--sher-text-sm);
}

@media (max-width: 479px) {
  .manage-add {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
