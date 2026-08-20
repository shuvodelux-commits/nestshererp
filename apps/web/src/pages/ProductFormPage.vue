<script setup lang="ts">
import type { ProductResponse } from '@sher/core-contracts';
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import ProductForm from '../components/ProductForm.vue';
import AppShell from '../components/shell/AppShell.vue';

/**
 * `/products/:id` — the product form as its own screen.
 *
 * §5.5 makes Products the working hub and the form normally opens as a dialog
 * over the list (UI-50). This route stays because UI-13 requires every screen
 * to have a stable path a shopkeeper can bookmark or be linked to, and because
 * a phone has room for a full screen where it has none for a wide dialog.
 *
 * It is deliberately a thin wrapper: the form, its validation and its save path
 * live in `ProductForm` and are shared with the dialog, so the two can never
 * drift into disagreeing about what a product is.
 */
const route = useRoute();
const router = useRouter();

const productId = computed(() => {
  const id = route.params['id'];
  return typeof id === 'string' && id !== 'new' ? id : null;
});

const isNew = computed(() => productId.value === null);

function backToList(): void {
  void router.push('/products');
}

/**
 * UI-36: a new product lands on itself, so the shopkeeper sees what the server
 * actually stored. Saving an existing one stays where it is — the form already
 * shows the saved state and says so.
 */
function onSaved(product: ProductResponse): void {
  if (isNew.value) void router.push(`/products/${product.id}`);
}
</script>

<template>
  <AppShell
    :title="isNew ? 'Add product' : 'Product'"
    :breadcrumb="['Dashboard', 'Products', isNew ? 'Add' : 'Edit']"
    help-bn="নাম, ইউনিট আর দাম — এই কয়টাই আবশ্যক"
  >
    <template #actions>
      <button type="button" class="btn btn-ghost" @click="backToList">
        <i class="pi pi-arrow-left" aria-hidden="true" />
        Back to products
      </button>
    </template>

    <ProductForm
      :key="productId ?? 'new'"
      :product-id="productId"
      @saved="onSaved"
      @close="backToList"
      @deleted="backToList"
    />
  </AppShell>
</template>
