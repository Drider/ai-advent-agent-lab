<script setup lang="ts">
import type { TaskSnapshot } from '../shared/task'
defineProps<{ items: TaskSnapshot[] }>()
defineEmits<{ openArtifact: [taskId: string, artifactId: string] }>()
</script>
<template>
  <details v-if="items.length">
    <summary>История задач ({{ items.length }})</summary>
    <details v-for="task in items" :key="task.id" class="history-task">
      <summary>{{ task.task }} · {{ task.status === 'done' ? 'Завершена' : 'Отменена' }}</summary>
      <p>{{ task.stage }} · {{ task.step }}</p>
      <UButton v-for="artifact in task.artifacts" :key="artifact.id" variant="link" size="xs" @click="$emit('openArtifact', task.id, artifact.id)">{{ artifact.key }} · v{{ artifact.version }}</UButton>
    </details>
  </details>
</template>
<style scoped>.history-task { margin: .5rem 0 .5rem .8rem; } summary { cursor: pointer; }</style>
