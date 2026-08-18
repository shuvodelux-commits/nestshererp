<script setup lang="ts">
/**
 * A failure, said in a way the person reading it can act on.
 *
 * UI-28 requires the server's error **code** to stay visible — when a shopkeeper
 * rings for help, "it says PERMISSION_DENIED" is how the problem gets found in
 * seconds. But the code is for that phone call, not for the person's decision,
 * so the sentence comes first and the code sits after it, small and grey.
 *
 * What UI-28 forbids is the opposite of a code: "Something went wrong" and a
 * silent catch. This shows both, in the order that matches who needs which.
 */
defineProps<{ code: string; message: string; tone?: 'error' | 'warning' }>();
</script>

<template>
  <p class="error-notice" :class="tone === 'warning' ? 'is-warning' : 'is-error'" role="alert">
    <span class="message">{{ message }}</span>
    <span class="reference">
      Reference: <code>{{ code }}</code>
    </span>
  </p>
</template>

<style scoped>
.error-notice {
  margin: 0;
  padding: 11px 14px;
  border: 1px solid;
  border-radius: var(--sher-radius);
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.is-error {
  border-color: var(--sher-bad-line);
  background: var(--sher-bad-bg);
}

.is-warning {
  border-color: var(--sher-warn-line);
  background: var(--sher-warn-bg);
}

/* The sentence is the message. It reads at normal size, in normal text colour. */
.message {
  font-size: var(--sher-text-base);
  color: var(--sher-text);
}

/* The code is a support reference, not the explanation. */
.reference {
  font-size: var(--sher-text-2xs);
  color: var(--sher-text-muted);
}

code {
  font-family: var(--sher-font-mono);
  letter-spacing: 0.03em;
}
</style>
