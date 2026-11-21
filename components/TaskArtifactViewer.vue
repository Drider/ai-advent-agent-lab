<script setup lang="ts">
import type { TaskArtifact } from '../shared/task'
defineProps<{ artifact: TaskArtifact }>()
defineEmits<{ close: [] }>()
</script>
<template>
  <section class="artifact" aria-label="Материал задачи">
    <header><strong>{{ artifact.key }} · v{{ artifact.version }}</strong>
      <UButton size="xs" color="neutral" variant="ghost" @click="$emit('close')">Закрыть</UButton></header>
    <pre>{{ typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content, null, 2) }}</pre>
  </section>
</template>
<style scoped>
.artifact { padding: .7rem; border: 1px solid var(--ui-border); border-radius: .5rem; }
header { display: flex; justify-content: space-between; }
pre { max-height: 15rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
