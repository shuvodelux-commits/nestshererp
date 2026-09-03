<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';

import { session } from './api/session';
import AppShell from './components/AppShell.vue';

/**
 * The console is either the sign-in screen or the shell — never both, and never
 * the shell with an empty navigation while the session is still loading.
 */
const route = useRoute();
const signedIn = computed(() => session.operator !== null && route.meta['public'] !== true);
</script>

<template>
  <AppShell v-if="signedIn" />
  <RouterView v-else />
</template>
