<script setup lang="ts">
import type { TaskCommand, TaskView } from '../shared/task'
defineProps<{ view: TaskView; busy: boolean; error?: string | null; workflowName?: string }>()
const emit = defineEmits<{ action: [TaskCommand]; openArtifact: [string]; chooseWorkflow: [] }>()
const statuses = { active: 'Активна', paused: 'На паузе', done: 'Завершена', cancelled: 'Отменена' }
const actors = { user: 'Вы', agent: 'Ассистент', system: 'Система' }
</script>

<template>
  <section v-if="view.task" class="task-card" aria-label="Состояние задачи">
    <header><strong>{{ view.task.task }}</strong><span>{{ statuses[view.task.status] }}</span></header>
    <p>{{ view.task.workflowId ? (workflowName || view.task.workflowId) + ' · v' + view.task.workflowVersion : 'Без workflow' }}</p>
    <dl>
      <dt>Этап</dt><dd>{{ view.task.stage }}</dd>
      <dt>Шаг</dt><dd>{{ view.task.step }}</dd>
      <dt>Ожидается</dt><dd>{{ actors[view.task.expected.actor] }} · {{ view.task.expected.label }}</dd>
    </dl>
    <p v-if="view.task.progress">{{ view.task.progress }}</p>
    <div v-for="approval in view.approvals.filter(item => item.status === 'pending')" :key="approval.id">
      <button type="button" @click="emit('openArtifact', approval.artifact.id)">Посмотреть {{ approval.artifact.key }} · v{{ approval.artifact.version }}</button>
      <code>/task approve {{ approval.id }}</code>
    </div>
    <button v-if="view.task.result" type="button" @click="emit('openArtifact', view.task.result.id)">Результат · {{ view.task.result.key }} · v{{ view.task.result.version }}</button>
    <details v-if="view.validations.length">
      <summary>Проверки ({{ view.validations.length }})</summary>
      <p v-for="item in view.validations" :key="item.id">{{ item.checkId }} · {{ item.outcome }}</p>
    </details>
    <div v-for="op in view.recoveryOperations" :key="op.id">
      <p>{{ op.toolName }} · {{ op.path }} · {{ op.status }}</p>
      <p v-if="op.expectedHash">Ожидаемый хеш <code>{{ op.expectedHash }}</code></p>
      <p v-if="op.observedHash">Полученный хеш <code>{{ op.observedHash }}</code></p>
    </div>
    <div class="task-actions">
      <template v-for="action in view.actions" :key="[action.type,action.approvalId,action.recoveryOperationId].join('/')">
        <UButton v-if="action.type === 'attach'" size="xs" variant="soft" :disabled="busy" @click="emit('chooseWorkflow')">Подключить workflow</UButton>
        <UButton v-else-if="action.type === 'approve' && action.approvalId" size="xs" :disabled="busy" @click="emit('action', { type: 'approve', approvalId: action.approvalId })">{{ action.label }}</UButton>
        <template v-else-if="action.type === 'resolve_recovery' && action.recoveryOperationId">
          <UButton v-for="outcome in (['completed','failed'] as const)" :key="outcome" size="xs" variant="soft" :disabled="busy" @click="emit('action', { type: 'resolve_recovery', operationId: action.recoveryOperationId!, outcome })">{{ action.recoveryOperationId }} · {{ outcome === 'completed' ? 'Подтвердить выполнение' : 'Отметить сбой' }}</UButton>
        </template>
        <UButton v-else-if="action.type === 'pause' || action.type === 'resume' || action.type === 'cancel' || action.type === 'complete_basic'" size="xs" color="neutral" variant="soft" :disabled="busy" @click="emit('action', { type: action.type })">{{ action.label }}</UButton>
      </template>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.task-card { display: grid; gap: .45rem; line-height: 1.4; overflow-wrap: anywhere; }
header, .task-actions { display: flex; align-items: center; flex-wrap: wrap; gap: .5rem; }
header span { color: var(--ui-text-muted); }
dl { display: grid; grid-template-columns: auto 1fr; gap: .15rem .7rem; }
dt { color: var(--ui-text-muted); } dd, p { margin: 0; }
button, summary { cursor: pointer; } button { text-align: left; }
code { margin-inline-start: .5rem; }
</style>
