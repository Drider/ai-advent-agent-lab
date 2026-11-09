<script setup lang="ts">
import { getToolName } from 'ai'
import { computed } from 'vue'
import { getToolCallStatus, type ChatToolPart } from '~/shared/tool-call'

const props = defineProps<{
  part: ChatToolPart
  isActive: boolean
}>()

const status = computed(() => getToolCallStatus(props.part, props.isActive))
const statusSuffix = computed(() => status.value.label === 'Завершён' ? undefined : status.value.label)
</script>

<template>
  <UChatTool
    :text="getToolName(part)"
    :suffix="statusSuffix"
    :loading="status.loading"
    icon="i-lucide-wrench"
    variant="inline"
    :ui="{
      root: 'min-w-0',
      trigger: 'w-fit max-w-full gap-1 text-sm text-slate-500 hover:text-slate-700',
      leadingIcon: 'size-3.5 text-slate-400',
      label: 'text-xs',
      suffix: 'text-sm text-slate-500',
      trailingIcon: 'size-3.5 text-slate-400',
      body: 'ml-1.5 max-h-80 overflow-auto border-l border-slate-200 pl-3 text-slate-600 whitespace-normal',
    }"
  >
    <div class="tool-call-details">
      <div v-if="part.input !== undefined">
        <h3 class="tool-call-details__label">Аргументы</h3>
        <pre class="tool-call-details__value">{{ JSON.stringify(part.input, null, 2) }}</pre>
      </div>
      <div v-if="part.state === 'output-available'">
        <h3 class="tool-call-details__label">Результат</h3>
        <pre class="tool-call-details__value">{{ JSON.stringify(part.output, null, 2) }}</pre>
      </div>
      <p v-if="part.state === 'output-error'" class="tool-call-details__error" role="alert">
        {{ part.errorText }}
      </p>
    </div>
  </UChatTool>
</template>

<style scoped>
.tool-call-details {
  display: grid;
  min-width: 0;
  gap: 0.75rem;
}

.tool-call-details__label {
  margin: 0 0 0.35rem;
  color: #64748b;
  font-size: 0.875rem;
  font-weight: 500;
}

.tool-call-details__value {
  max-height: 18rem;
  overflow: auto;
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.tool-call-details__error {
  margin: 0;
  color: #b91c1c;
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}
</style>
