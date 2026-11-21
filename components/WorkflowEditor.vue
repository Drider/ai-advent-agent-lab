<script setup lang="ts">
import { computed, ref } from 'vue'
import type { WorkflowSummary, WorkflowVersion } from '../shared/workflow'
import { useWorkflows, type SourceFormat } from '../composables/useWorkflows'
const props = defineProps<{ workflow?: WorkflowSummary; version?: WorkflowVersion }>()
const emit = defineEmits<{ published: [WorkflowVersion]; busyChange: [boolean] }>()
const name = ref(props.workflow?.name ?? '')
const source = ref(props.version ? JSON.stringify(props.version.definition, null, 2) : '')
const format = ref<SourceFormat>('json')
const message = ref('')
const failed = ref(false)
const busy = ref(false)
const { publish, validate } = useWorkflows()
const ready = computed(() => !!source.value.trim() && !busy.value)
async function submit(action: 'validate' | 'publish') {
  if (!ready.value) return
  busy.value = true
  emit('busyChange', true)
  message.value = ''
  failed.value = false
  try {
    const input = { source: source.value, format: format.value }
    if (action === 'validate') {
      await validate(input.source, input.format)
      message.value = 'Схема прошла проверку.'
    } else {
      const version = await publish(props.version
        ? { ...input, id: props.version.workflowId, expectedVersion: props.version.version }
        : { ...input, name: name.value.trim() })
      emit('published', version)
      message.value = 'Опубликована версия ' + version.version
    }
  } catch (e) {
    failed.value = true
    const data = (e as { data?: { statusMessage?: string; data?: { errors?: Array<{ path: string; message: string }> } } }).data
    message.value = data?.data?.errors?.map(issue => issue.path + ' — ' + issue.message).join('\n')
      || data?.statusMessage || (e instanceof Error ? e.message : 'Не удалось обработать схему.')
  } finally {
    busy.value = false
    emit('busyChange', false)
  }
}
</script>
<template>
  <section class="editor">
    <h2>{{ workflow?.name || 'Новый workflow' }} <small v-if="version">v{{ version.version }}</small></h2>
    <label v-if="!version">Название <UInput v-model="name" maxlength="200" :disabled="busy" /></label>
    <label>Формат <select v-model="format" :disabled="busy" @change="message = ''"><option value="json">JSON</option><option value="yaml">YAML</option></select></label>
    <label>Схема <textarea v-model="source" rows="18" spellcheck="false" :disabled="busy" @input="message = ''"></textarea></label>
    <div><UButton variant="soft" :disabled="!ready" @click="submit('validate')">Проверить схему</UButton>
      <UButton :disabled="!ready || (!version && !name.trim())" @click="submit('publish')">Опубликовать версию</UButton></div>
    <p v-if="message" :role="failed ? 'alert' : 'status'">{{ message }}</p>
  </section>
</template>
<style scoped>
.editor { min-width: 0; display: grid; gap: .75rem; border: 1px solid var(--ui-border); border-radius: .7rem; padding: 1rem; } h2 { font-weight: 650; }
label { display: grid; gap: .3rem; } textarea, select { border: 1px solid var(--ui-border); border-radius: .35rem; padding: .45rem; }
textarea { width: 100%; font-family: monospace; } .editor div { display: flex; gap: .5rem; flex-wrap: wrap; }
p { white-space: pre-wrap; } [role=alert] { color: var(--ui-error); }
</style>
