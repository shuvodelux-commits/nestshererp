<script setup lang="ts">
import { ref } from 'vue';

import { ApiError } from '../api/client';
import Tooltip from './Tooltip.vue';

/**
 * The `Manage` panel behind every master-data picker (UI-51).
 *
 * Tapping `Manage` beside Category, Brand or Unit opens this: the whole list of
 * that thing, each row carrying its own `⋯` menu with `Edit` and `Delete`. The
 * rule it implements is "the actions for a thing live where the thing is shown"
 * — a shopkeeper who mistypes a category while adding a product should not have
 * to find a settings screen to fix it, and most will never look for one.
 *
 * It is the other half of quick add (UI-45): that creates what is missing from
 * the point of use, this repairs what is already there. Both call the **same**
 * use case as the full screen, so there is one write path, one set of
 * validations and one audit trail (R-D, DRY).
 *
 * **Delete is §3.6's delete-or-archive, and the caller is told which happened.**
 * A name nothing carries is removed; a name products already carry is archived,
 * because deleting it outright would leave every one of those products pointing
 * at nothing. The server decides and says which — this component never guesses,
 * and never claims "deleted" when the answer was "archived".
 */
const props = defineProps<{
  /** What is being managed, in the words on the picker: "Category". */
  title: string;
  titleBn?: string | undefined;
  entries: readonly { readonly id: string; readonly name: string }[];
  canEdit: boolean;
  /**
   * Adding lives here too, so one control answers the whole question — "what
   * are my categories, and let me fix them". A separate `+ New` button beside
   * the picker was a second place to look for the same job.
   */
  canAdd: boolean;
  addPlaceholder?: string | undefined;
  /** All three go through the same use cases the settings screen calls. */
  create: (name: string) => Promise<string>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<string>;
}>();

const emit = defineEmits<{
  close: [];
  /** The id the server gave the new entry, so the picker can select it (UI-36). */
  created: [id: string];
}>();

const newName = ref('');

/**
 * Creating selects the new entry in the picker behind, because a shopkeeper who
 * has just typed "Fittings" means to use it. The id comes from the server's
 * response — never matched by name, which would pick the wrong row the moment
 * two names normalise the same way.
 */
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

/** Which row's `⋯` menu is open. One at a time — two would be two menus to close. */
const menuFor = ref<string | null>(null);
const editing = ref<string | null>(null);
const draft = ref('');
const busy = ref(false);
const error = ref<{ code: string; message: string } | null>(null);
/** What the server said Delete actually did, in its own words (§3.6). */
const outcome = ref<string | null>(null);

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

function startEdit(entry: { id: string; name: string }): void {
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

/**
 * Deleting asks first, and the confirmation names the record (UI-26).
 *
 * `confirming` rather than a browser `confirm()`: the native one cannot carry
 * Bangla helper text, cannot be styled, and on a phone appears as a system
 * dialog people dismiss without reading.
 */
const confirming = ref<{ id: string; name: string } | null>(null);

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
  <div class="manage-backdrop" @click.self="emit('close')">
    <div class="manage-panel" role="dialog" aria-modal="true" :aria-label="`Manage ${title}`">
      <header class="manage-head">
        <div>
          <h2>Manage {{ title }}</h2>
          <p v-if="titleBn" class="sher-bn">{{ titleBn }}</p>
        </div>
        <button type="button" class="icon-btn" aria-label="Close" @click="emit('close')">
          <i class="pi pi-times" aria-hidden="true" />
        </button>
      </header>

      <p v-if="error !== null" class="manage-error">
        {{ error.message }}
        <span class="fine">{{ error.code }}</span>
      </p>
      <p v-if="outcome !== null" class="manage-outcome">{{ outcome }}</p>

      <!--
        Adding sits at the top, because opening this panel is most often the
        moment someone realised the thing they wanted is not in the list.
      -->
      <div v-if="canAdd" class="manage-add">
        <input
          v-model="newName"
          type="text"
          :placeholder="addPlaceholder ?? 'New name'"
          :aria-label="`New ${title}`"
          @keyup.enter="addEntry"
        />
        <button type="button" class="btn btn-primary" :disabled="busy" @click="addEntry">
          Add
        </button>
      </div>

      <p v-if="entries.length === 0" class="manage-empty">Nothing here yet — add the first one above.</p>

      <ul v-else class="manage-list">
        <li v-for="entry in entries" :key="entry.id">
          <template v-if="editing === entry.id">
            <input
              v-model="draft"
              type="text"
              class="manage-input"
              :aria-label="`Rename ${entry.name}`"
              @keyup.enter="saveEdit(entry.id)"
              @keyup.esc="editing = null"
            />
            <button type="button" class="btn btn-primary sm" :disabled="busy" @click="saveEdit(entry.id)">
              Save
            </button>
            <button type="button" class="btn btn-ghost sm" @click="editing = null">Cancel</button>
          </template>

          <template v-else>
            <span class="manage-name">{{ entry.name }}</span>

            <!--
              The row's own actions, behind `⋯` so a long list stays readable.
              Absent entirely without the permission (UI-09) — a menu whose every
              item 403s is worse than no menu.
            -->
            <div v-if="canEdit" class="manage-actions">
              <Tooltip text="Edit or delete" text-bn="নাম বদলান বা মুছুন">
                <button
                  type="button"
                  class="icon-btn"
                  :class="{ 'is-open': menuFor === entry.id }"
                  :aria-label="`Actions for ${entry.name}`"
                  :aria-expanded="menuFor === entry.id"
                  @click.stop="menuFor = menuFor === entry.id ? null : entry.id"
                >
                  <i class="pi pi-ellipsis-h" aria-hidden="true" />
                </button>
              </Tooltip>
            </div>

            <!--
              The actions open **in the row**, not in a floating menu. A menu
              positioned over a scrollable panel is clipped by it: the first
              version put Edit and Delete below the panel's edge, so choosing one
              meant scrolling to reach it. A row that expands cannot be clipped,
              needs no scrolling, and pushes the rest of the list down where it
              stays readable.
            -->
            <div v-if="menuFor === entry.id" class="manage-menu">
              <button type="button" @click="startEdit(entry)">
                <i class="pi pi-pencil" aria-hidden="true" /> Edit
              </button>
              <button
                type="button"
                class="is-danger"
                @click="((confirming = entry), (menuFor = null))"
              >
                <i class="pi pi-trash" aria-hidden="true" /> Delete
              </button>
            </div>
          </template>
        </li>
      </ul>

      <!-- UI-26: a destructive action names the record and its consequence. -->
      <div v-if="confirming !== null" class="manage-confirm">
        <p>
          Remove <strong>{{ confirming.name }}</strong
          >?
        </p>
        <p class="sher-bn">
          এটি যদি কোনো পণ্যে ব্যবহার হয়ে থাকে, তবে মুছে না গিয়ে শুধু তালিকা থেকে সরে যাবে।
        </p>
        <p class="fine">
          If products already use it, it is archived rather than deleted, so nothing they record
          changes. You will be told which happened.
        </p>
        <div class="manage-confirm-actions">
          <button type="button" class="btn btn-ghost" @click="confirming = null">Cancel</button>
          <button type="button" class="btn btn-danger" :disabled="busy" @click="confirmRemove">
            Remove
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.manage-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: var(--sher-space-4);
  background: rgb(15 23 42 / 45%);
}

.manage-panel {
  width: min(30rem, 100%);
  max-height: min(80vh, 40rem);
  overflow-y: auto;
  padding: var(--sher-card-pad);
  border-radius: var(--sher-radius-lg);
  background: var(--sher-raised);
  box-shadow: var(--sher-shadow-card);
}

.manage-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sher-space-3);
  margin-bottom: var(--sher-space-4);
}

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

.icon-btn {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  background: none;
  border: 0;
  border-radius: var(--sher-radius);
  color: var(--sher-text-muted);
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--sher-primary-soft);
  color: var(--sher-primary);
}

.manage-add {
  display: flex;
  gap: var(--sher-space-2);
  margin-bottom: var(--sher-space-3);
  padding-bottom: var(--sher-space-3);
  border-bottom: 1px solid var(--sher-line);
}

.manage-add input {
  flex: 1;
  min-width: 0;
}

.manage-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.manage-list li {
  display: flex;
  align-items: center;
  /* Wraps so the expanded actions take a line of their own inside the row. */
  flex-wrap: wrap;
  gap: var(--sher-space-2);
  min-height: 52px;
  padding: var(--sher-space-1) 0;
  border-bottom: 1px solid var(--sher-line);
}

.manage-name {
  flex: 1;
  min-width: 0;
}

.manage-actions {
  position: relative;
}

/* Open reads as open. Two borderless words appearing under a row were easy to
   miss entirely — reported from the running app as "nothing happened after
   clicking the three dots" — so the trigger holds a pressed state while its
   menu is showing, and the menu itself is a panel rather than bare text. */
.icon-btn.is-open {
  background: var(--sher-primary-soft);
  color: var(--sher-primary);
}

.manage-menu {
  /* In the flow, not floating: a panel with `overflow-y: auto` clips an
     absolutely positioned menu, which is what forced scrolling to reach Edit. */
  display: flex;
  gap: var(--sher-space-2);
  width: 100%;
  margin-bottom: var(--sher-space-1);
  padding: var(--sher-space-2);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-sunken, #f8fafc);
}

.manage-menu button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sher-space-2);
  flex: 1;
  min-height: 44px;
  padding: 0 var(--sher-space-2);
  border: 1px solid var(--sher-line-strong);
  border-radius: var(--sher-radius);
  background: var(--sher-raised);
  font: inherit;
  font-weight: 600;
  color: var(--sher-text);
  cursor: pointer;
}

.manage-menu button:hover {
  border-color: var(--sher-primary);
  background: var(--sher-primary-soft);
  color: var(--sher-primary);
}

.manage-menu .is-danger {
  color: var(--sher-bad, #b91c1c);
}

.manage-menu .is-danger:hover {
  border-color: var(--sher-bad, #b91c1c);
  background: var(--sher-bad-bg, #fef2f2);
  color: var(--sher-bad, #b91c1c);
}

.manage-input {
  flex: 1;
  min-width: 0;
}

.manage-empty,
.manage-error,
.manage-outcome {
  margin: 0 0 var(--sher-space-3);
  font-size: var(--sher-text-sm);
}

.manage-error {
  color: var(--sher-danger, #b91c1c);
}

.manage-confirm {
  margin-top: var(--sher-space-4);
  padding: var(--sher-space-3);
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-sunken, #f8fafc);
}

.manage-confirm p {
  margin: 0 0 var(--sher-space-1);
}

.manage-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sher-space-2);
  margin-top: var(--sher-space-3);
}

.sm {
  min-height: 40px;
}
</style>
