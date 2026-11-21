<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { WorkflowSummary } from '../shared/workflow'
const props = defineProps<{ items: WorkflowSummary[]; busy: boolean }>()
defineEmits<{ attach: [workflowId: string, version: number] }>()
const id = ref('')
const selected = computed(() => props.items.find(item => item.id === id.value))
const version = ref(1)
watch(selected, item => { version.value = item?.latestVersion ?? 1 })
</script>
<template>
  <form class="selector" @submit.prevent="selected && $emit('attach', selected.id, version)">
    <label>Workflow <select v-model="id" required :disabled="busy"><option value="" disabled>Выберите процесс</option><option v-for="item in items" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <label v-if="selected">Версия <input v-model.number="version" type="number" min="1" :max="selected.latestVersion" required :disabled="busy"></label>
    <UButton type="submit" size="xs" :disabled="busy || !selected">Подключить</UButton>
  </form>
</template>
<style scoped>
.selector { display: flex; align-items: center; flex-wrap: wrap; gap: .65rem; }
select, input { border: 1px solid var(--ui-border); padding: .3rem; border-radius: .28rem; } input { width: 4rem; }
</style>
