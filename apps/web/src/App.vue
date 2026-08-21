<script setup lang="ts">
import ConfirmDialog from 'primevue/confirmdialog';
import Toast from 'primevue/toast';
import { computed } from 'vue';
import { RouterView, useRoute } from 'vue-router';

import AppLayout from './components/shell/AppLayout.vue';
import { PUBLIC_ROUTES } from './router';

const route = useRoute();

/**
 * Signing in is the only boundary that changes the layout. Everything behind it
 * shares one shell, mounted once here, so navigating between modules never
 * rebuilds the sidebar or the top bar.
 */
const insideShell = computed(
  () => typeof route.name !== 'string' || !PUBLIC_ROUTES.has(route.name),
);
</script>

<template>
  <Toast />
  <ConfirmDialog />
  <AppLayout v-if="insideShell" />
  <RouterView v-else />
</template>
