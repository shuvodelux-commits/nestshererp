<script setup lang="ts">
import type { CatalogResponse, CategoryResponse } from '@sher/core-contracts';
import { computed, onMounted, ref } from 'vue';

import type { CatalogKind } from '../api/catalog';
import {
  createCatalogEntry,
  EMPTY_CATALOG,
  fetchCatalog,
  removeCatalogEntry,
  renameCatalogEntry,
} from '../api/catalog';
import { ApiError } from '../api/client';
import { useSession } from '../auth/session';
import AppCard from '../components/AppCard.vue';
import EmptyState from '../components/EmptyState.vue';
import ErrorNotice from '../components/ErrorNotice.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * Catalog setup (Phase 2, path 2.1): the words this shop describes its goods
 * with — units of measure (D-10), brands and categories (§5.5).
 *
 * A List screen (UI-22) three times over, in tabs rather than three routes: they
 * are one job ("get the catalog ready"), each list is short, and a shopkeeper
 * setting up moves between them constantly.
 *
 * Each list has its own permission (§5.26), so the tab is readable while the Add
 * button is absent — a caller who may file products under a category but may not
 * invent a unit of measure sees exactly that.
 */
const session = useSession();

const canManage: Record<CatalogKind, () => boolean> = {
  units: () => session.can('catalog.unit.manage'),
  brands: () => session.can('catalog.brand.manage'),
  categories: () => session.can('catalog.category.manage'),
};

const tabs = [
  { kind: 'units' as CatalogKind, label: 'Units', icon: 'pi-inbox' },
  { kind: 'brands' as CatalogKind, label: 'Brands', icon: 'pi-tag' },
  { kind: 'categories' as CatalogKind, label: 'Categories', icon: 'pi-sitemap' },
];

const tab = ref<CatalogKind>('units');

const loading = ref(true);
const loadError = ref<{ code: string; message: string } | null>(null);
const catalog = ref<CatalogResponse>(EMPTY_CATALOG);

const busy = ref(false);
const formError = ref<{ code: string; message: string } | null>(null);
const notice = ref<string | null>(null);

function describe(cause: unknown): { code: string; message: string } {
  return cause instanceof ApiError
    ? { code: cause.code, message: cause.message }
    : { code: 'UNEXPECTED', message: cause instanceof Error ? cause.message : String(cause) };
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    catalog.value = await fetchCatalog(session.accessToken.value ?? '');
  } catch (cause) {
    loadError.value = describe(cause);
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/* ------------------------------------------------------------------ reading */

const parents = computed(() => catalog.value.categories.filter((row) => row.parentId === null));

/** Subcategories, grouped under the parent they belong to. */
function childrenOf(parentId: string): readonly CategoryResponse[] {
  return catalog.value.categories.filter((row) => row.parentId === parentId);
}

const currentCount = computed(() => {
  if (tab.value === 'units') return catalog.value.units.length;
  if (tab.value === 'brands') return catalog.value.brands.length;
  return catalog.value.categories.length;
});

/* ------------------------------------------------------------------ writing */

/** Which dialog is open: adding, or renaming an existing row. */
type Editing =
  | { mode: 'ADD'; kind: CatalogKind; parentId: string | null; parentName: string | null }
  | { mode: 'RENAME'; kind: CatalogKind; id: string; was: string }
  | null;

const editing = ref<Editing>(null);
const draftName = ref('');

function openAdd(kind: CatalogKind, parent: CategoryResponse | null = null): void {
  editing.value = {
    mode: 'ADD',
    kind,
    parentId: parent === null ? null : parent.id,
    parentName: parent === null ? null : parent.name,
  };
  draftName.value = '';
  formError.value = null;
}

function openRename(kind: CatalogKind, id: string, was: string): void {
  editing.value = { mode: 'RENAME', kind, id, was };
  draftName.value = was;
  formError.value = null;
}

function close(): void {
  editing.value = null;
  draftName.value = '';
}

const canSubmit = computed(() => !busy.value && draftName.value.trim() !== '');

async function submit(): Promise<void> {
  const target = editing.value;
  if (target === null) return;

  busy.value = true;
  formError.value = null;
  try {
    const name = draftName.value.trim();
    if (target.mode === 'ADD') {
      catalog.value = await createCatalogEntry(
        session.accessToken.value ?? '',
        target.kind,
        target.kind === 'categories' ? { name, parentId: target.parentId } : { name },
      );
      notice.value = `${name} was added.`;
    } else {
      catalog.value = await renameCatalogEntry(
        session.accessToken.value ?? '',
        target.kind,
        target.id,
        name,
      );
      notice.value = `${target.was} is now called ${name}.`;
    }
    close();
  } catch (cause) {
    formError.value = describe(cause);
  } finally {
    busy.value = false;
  }
}

/* ----------------------------------------------------------------- removing */

const removing = ref<{ kind: CatalogKind; id: string; name: string } | null>(null);

function askToRemove(kind: CatalogKind, id: string, name: string): void {
  removing.value = { kind, id, name };
  formError.value = null;
}

async function remove(): Promise<void> {
  const target = removing.value;
  if (target === null) return;

  busy.value = true;
  formError.value = null;
  try {
    const result = await removeCatalogEntry(
      session.accessToken.value ?? '',
      target.kind,
      target.id,
    );
    // The server decides which of the two happened (§3.6), and says so.
    notice.value =
      result.outcome === 'DELETED'
        ? `${target.name} was removed.`
        : `${target.name} is no longer offered for new products. Products that already use it keep it.`;
    removing.value = null;
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
    title="Catalog setup"
    :breadcrumb="['Dashboard', 'Catalog setup']"
    help-bn="পণ্যের ইউনিট, ব্র্যান্ড আর ক্যাটাগরি এখানে ঠিক করুন"
  >
    <template #actions>
      <button
        v-if="canManage[tab]()"
        type="button"
        class="btn btn-primary"
        @click="openAdd(tab)"
      >
        <i class="pi pi-plus" aria-hidden="true" />
        Add {{ tab === 'units' ? 'unit' : tab === 'brands' ? 'brand' : 'category' }}
      </button>
    </template>

    <div v-if="loading" class="skeletons" aria-busy="true" aria-label="Loading the catalog">
      <div class="skeleton skeleton-tabs" />
      <div class="skeleton skeleton-table" />
    </div>

    <AppCard v-else-if="loadError !== null" title="Could not load your catalog">
      <ErrorNotice :code="loadError.code" :message="loadError.message" />
      <button type="button" class="btn btn-ghost retry" @click="load">Try again</button>
    </AppCard>

    <template v-else>
      <p v-if="notice !== null" class="notice is-ok" role="status">{{ notice }}</p>

      <!-- UI-25: the choice of list is visible on the screen, not in a menu. -->
      <nav class="tabs" aria-label="Catalog lists">
        <button
          v-for="entry in tabs"
          :key="entry.kind"
          type="button"
          class="tab"
          :class="{ 'is-current': tab === entry.kind }"
          :aria-current="tab === entry.kind"
          @click="tab = entry.kind"
        >
          <i class="pi" :class="entry.icon" aria-hidden="true" />
          {{ entry.label }}
        </button>
      </nav>

      <!-- ------------------------------------------------------------ units -->
      <AppCard
        v-if="tab === 'units'"
        title="Units of measure"
        subtitle="How you buy, keep and sell each product — piece, carton, kilogram. Every product needs one."
      >
        <EmptyState v-if="catalog.units.length === 0" icon="pi-inbox" title="No units yet">
          A product cannot be added without a base unit.
          <template #action>
            <button
              v-if="canManage.units()"
              type="button"
              class="btn btn-primary"
              @click="openAdd('units')"
            >
              Add the first unit
            </button>
          </template>
        </EmptyState>

        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Unit</th>
                <th v-if="canManage.units()" class="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="unit in catalog.units" :key="unit.id">
                <td>{{ unit.name }}</td>
                <td v-if="canManage.units()" class="actions">
                  <button type="button" class="linkish" @click="openRename('units', unit.id, unit.name)">
                    Rename
                  </button>
                  <button
                    type="button"
                    class="linkish danger"
                    @click="askToRemove('units', unit.id, unit.name)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </AppCard>

      <!-- ----------------------------------------------------------- brands -->
      <AppCard
        v-if="tab === 'brands'"
        title="Brands"
        subtitle="Kept apart from the product name, so a product reads as Brand + Name and renaming the brand renames it everywhere."
      >
        <EmptyState v-if="catalog.brands.length === 0" icon="pi-tag" title="No brands yet">
          A product does not need a brand. Add the ones you stock and they become a filter on
          the Products screen.
          <template #action>
            <button
              v-if="canManage.brands()"
              type="button"
              class="btn btn-primary"
              @click="openAdd('brands')"
            >
              Add the first brand
            </button>
          </template>
        </EmptyState>

        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Brand</th>
                <th v-if="canManage.brands()" class="actions-col">Actions</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="brand in catalog.brands" :key="brand.id">
                <td>{{ brand.name }}</td>
                <td v-if="canManage.brands()" class="actions">
                  <button
                    type="button"
                    class="linkish"
                    @click="openRename('brands', brand.id, brand.name)"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    class="linkish danger"
                    @click="askToRemove('brands', brand.id, brand.name)"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </AppCard>

      <!-- ------------------------------------------------------- categories -->
      <AppCard
        v-if="tab === 'categories'"
        title="Categories"
        subtitle="Two levels: a category, and the subcategories inside it. Both become filters on the Products screen."
      >
        <EmptyState
          v-if="catalog.categories.length === 0"
          icon="pi-sitemap"
          title="No categories yet"
        >
          Group your goods so they can be found — Drinks, then Juice inside it.
          <template #action>
            <button
              v-if="canManage.categories()"
              type="button"
              class="btn btn-primary"
              @click="openAdd('categories')"
            >
              Add the first category
            </button>
          </template>
        </EmptyState>

        <ul v-else class="tree">
          <li v-for="parent in parents" :key="parent.id">
            <div class="tree-row">
              <span class="tree-name">{{ parent.name }}</span>
              <span class="tree-actions">
                <button
                  v-if="canManage.categories()"
                  type="button"
                  class="linkish"
                  @click="openAdd('categories', parent)"
                >
                  Add subcategory
                </button>
                <button
                  v-if="canManage.categories()"
                  type="button"
                  class="linkish"
                  @click="openRename('categories', parent.id, parent.name)"
                >
                  Rename
                </button>
                <button
                  v-if="canManage.categories()"
                  type="button"
                  class="linkish danger"
                  @click="askToRemove('categories', parent.id, parent.name)"
                >
                  Remove
                </button>
              </span>
            </div>

            <ul v-if="childrenOf(parent.id).length > 0" class="tree-children">
              <li v-for="child in childrenOf(parent.id)" :key="child.id">
                <div class="tree-row">
                  <span class="tree-name is-child">{{ child.name }}</span>
                  <span class="tree-actions">
                    <button
                      v-if="canManage.categories()"
                      type="button"
                      class="linkish"
                      @click="openRename('categories', child.id, child.name)"
                    >
                      Rename
                    </button>
                    <button
                      v-if="canManage.categories()"
                      type="button"
                      class="linkish danger"
                      @click="askToRemove('categories', child.id, child.name)"
                    >
                      Remove
                    </button>
                  </span>
                </div>
              </li>
            </ul>
          </li>
        </ul>
      </AppCard>

      <p v-if="!canManage[tab]() && currentCount > 0" class="fine">
        You can see this list, but not change it. Ask the business owner to add or rename an
        entry.
      </p>
    </template>

    <!-- ----------------------------------------------------- add / rename -->
    <div v-if="editing !== null" class="scrim" @click.self="close">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>
          <template v-if="editing.mode === 'RENAME'">Rename {{ editing.was }}</template>
          <template v-else-if="editing.parentName !== null">
            Add a subcategory inside {{ editing.parentName }}
          </template>
          <template v-else>
            Add {{ editing.kind === 'units' ? 'a unit' : editing.kind === 'brands' ? 'a brand' : 'a category' }}
          </template>
        </h2>

        <form @submit.prevent="submit">
          <ErrorNotice
            v-if="formError !== null"
            :code="formError.code"
            :message="formError.message"
          />

          <div class="field">
            <label for="catalog-name">Name</label>
            <input id="catalog-name" v-model="draftName" type="text" required :disabled="busy" />
            <p v-if="editing.kind === 'units'" class="help">
              What you count this product in — Piece, Carton, Kg.
            </p>
          </div>

          <div class="dialog-actions">
            <button type="button" class="btn btn-ghost" :disabled="busy" @click="close">
              Cancel
            </button>
            <button type="submit" class="btn btn-primary" :disabled="!canSubmit">
              {{ busy ? 'Saving…' : editing.mode === 'RENAME' ? 'Save changes' : 'Add' }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <!-- ----------------------------------------------------------- removal -->
    <div v-if="removing !== null" class="scrim" @click.self="removing = null">
      <div class="dialog" role="dialog" aria-modal="true">
        <h2>Remove {{ removing.name }}?</h2>
        <p class="lede">
          If nothing uses it, it is removed. If products already use it, it stops being offered
          for new ones and those products keep it exactly as it is.
        </p>

        <ErrorNotice v-if="formError !== null" :code="formError.code" :message="formError.message" />

        <div class="dialog-actions">
          <button type="button" class="btn btn-ghost" :disabled="busy" @click="removing = null">
            Cancel
          </button>
          <button type="button" class="btn btn-danger" :disabled="busy" @click="remove">
            {{ busy ? 'Removing…' : 'Remove' }}
          </button>
        </div>
      </div>
    </div>
  </AppShell>
</template>

<style scoped>
/*
 * Buttons, fields, tables, dialogs, notices and skeletons come from
 * `design/components.css`. What is left here is the two shapes only this screen
 * has: the tab strip and the two-level category tree.
 */
.skeletons {
  display: flex;
  flex-direction: column;
  gap: var(--sher-space-5);
}

.skeleton-tabs {
  height: var(--sher-tap);
  max-width: 340px;
}

.skeleton-table {
  height: 320px;
}

.retry {
  margin-top: var(--sher-space-4);
}

.tabs {
  display: flex;
  gap: var(--sher-space-2);
  margin-bottom: var(--sher-space-4);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 16px;
  border: 1px solid var(--sher-line);
  border-radius: var(--sher-radius);
  background: var(--sher-raised);
  color: var(--sher-text-muted);
  font-size: var(--sher-text-base);
  font-weight: 500;
  cursor: pointer;
  transition:
    background var(--sher-transition),
    color var(--sher-transition);
}

.tab:hover {
  background: var(--sher-hover);
  color: var(--sher-text);
}

/* The same soft primary pill the sidebar uses for "you are here" (§2.7.I). */
.tab.is-current {
  background: var(--sher-nav-active-bg);
  border-color: transparent;
  color: var(--sher-nav-active-fg);
  font-weight: 600;
}

.tab.is-current .pi {
  color: var(--sher-nav-active-icon);
}

.tree {
  list-style: none;
  margin: 0;
  padding: 0;
}

.tree-children {
  list-style: none;
  margin: 0;
  padding-left: 28px;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: var(--sher-space-3);
  padding: 10px 4px;
  border-bottom: 1px solid var(--sher-line);
}

.tree-name {
  font-weight: 600;
}

/* A subcategory reads as belonging to the row above it, not competing with it. */
.tree-name.is-child {
  font-weight: 500;
  color: var(--sher-text-muted);
}

.tree-actions {
  margin-left: auto;
  display: flex;
  gap: var(--sher-space-3);
}
</style>
