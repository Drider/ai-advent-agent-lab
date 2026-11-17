<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MemoryBudgetPatch, MemoryBudgets, MemoryPreview } from '~/shared/memory'

const props = defineProps<{
  budgets: MemoryBudgets
  preview: MemoryPreview
  saving: boolean
}>()

const emit = defineEmits<{ save: [patch: MemoryBudgetPatch] }>()
const workingTokens = ref(props.budgets.workingTokens)
const longTermTokens = ref(props.budgets.longTermTokens)
const error = ref<string | null>(null)

watch(() => props.budgets, budgets => {
  workingTokens.value = budgets.workingTokens
  longTermTokens.value = budgets.longTermTokens
})

const progress = computed(() => ({
  working: Math.min(100, props.preview.working.percent),
  longTerm: Math.min(100, props.preview.longTerm.percent),
}))

function save(): void {
  if (![workingTokens.value, longTermTokens.value].every(value => Number.isSafeInteger(value) && value >= 100 && value <= 100_000)) {
    error.value = 'Бюджет должен быть целым числом от 100 до 100000 токенов.'
    return
  }
  error.value = null
  emit('save', { workingTokens: workingTokens.value, longTermTokens: longTermTokens.value, expectedRevision: props.budgets.revision })
}
</script>

<template>
  <section class="memory-card memory-budget-settings" aria-labelledby="memory-budget-title">
    <div class="memory-card__heading"><div><p class="memory-eyebrow">Контекст</p><h2 id="memory-budget-title">Бюджеты слоёв</h2></div><span class="memory-muted">100–100000 токенов</span></div>
    <div class="memory-budget-settings__grid">
      <label><span>Рабочая память</span><input v-model.number="workingTokens" type="number" min="100" max="100000" step="100"></label>
      <label><span>Долговременная память</span><input v-model.number="longTermTokens" type="number" min="100" max="100000" step="100"></label>
    </div>
    <div class="memory-budget-settings__progress">
      <div><div class="memory-progress__line"><span>Рабочий слой</span><strong>{{ preview.working.estimatedTokens }} / {{ preview.working.budgetTokens }} · {{ preview.working.percent.toFixed(1) }}%</strong></div><progress :value="progress.working" max="100" :class="{ 'memory-progress--over': preview.working.exceeded }" /></div>
      <div><div class="memory-progress__line"><span>Долговременный слой</span><strong>{{ preview.longTerm.estimatedTokens }} / {{ preview.longTerm.budgetTokens }} · {{ preview.longTerm.percent.toFixed(1) }}%</strong></div><progress :value="progress.longTerm" max="100" :class="{ 'memory-progress--over': preview.longTerm.exceeded }" /></div>
    </div>
    <p v-if="preview.working.exceeded || preview.longTerm.exceeded" class="memory-error" role="alert">Переполнение не обрезает записи: отключите или сократите записи перед отправкой.</p>
    <p v-if="error" class="memory-error" role="alert">{{ error }}</p>
    <button class="memory-button memory-button--primary" type="button" :disabled="props.saving" @click="save">{{ props.saving ? 'Сохраняем…' : 'Сохранить бюджеты' }}</button>
  </section>
</template>

<style scoped>
.memory-budget-settings__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
.memory-budget-settings label { display: grid; gap: .3rem; color: #475569; font-size: .78rem; font-weight: 600; }
.memory-budget-settings input { width: 100%; border: 1px solid #cbd5e1; border-radius: .45rem; padding: .5rem .6rem; font: inherit; }
.memory-budget-settings__progress { display: grid; gap: .8rem; margin-top: .9rem; }
.memory-progress__line { display: flex; justify-content: space-between; gap: .5rem; color: #64748b; font-size: .74rem; }
.memory-progress__line strong { color: #334155; font-weight: 600; }
.memory-budget-settings progress { width: 100%; height: .45rem; accent-color: #2563eb; }
.memory-budget-settings progress.memory-progress--over { accent-color: #dc2626; }
@media (max-width: 600px) { .memory-budget-settings__grid { grid-template-columns: 1fr; } }
</style>
