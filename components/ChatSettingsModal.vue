<script setup lang="ts">
import { ref, watch } from 'vue'
import type { ChatCostSettings, ChatContextStrategySettings } from '~/shared/chat'

const props = defineProps<{
  open: boolean
  modelId: string
  contextLimit: string
  defaultModel: string
  contextStrategy: ChatContextStrategySettings
  costSettings: ChatCostSettings
  detailedStatistics: boolean
  saveError?: string | null
}>()

const emit = defineEmits<{
  cancel: []
  save: [payload: {
    modelId: string
    contextLimit: string
    contextStrategy: ChatContextStrategySettings
    costSettings: ChatCostSettings
    detailedStatistics: boolean
  }]
}>()

const draftModelId = ref('')
const draftContextLimit = ref('')
const draftStrategy = ref<ChatContextStrategySettings>({ ...props.contextStrategy })
const draftCostSettings = ref<ChatCostSettings>({ ...props.costSettings })
const draftDetailedStatistics = ref(false)

function resetDraft(): void {
  draftModelId.value = props.modelId
  draftContextLimit.value = props.contextLimit
  draftStrategy.value = { ...props.contextStrategy }
  draftCostSettings.value = { ...props.costSettings }
  draftDetailedStatistics.value = props.detailedStatistics
}

watch(() => props.open, open => {
  if (open) resetDraft()
})

function save(): void {
  emit('save', {
    modelId: draftModelId.value,
    contextLimit: draftContextLimit.value,
    contextStrategy: { ...draftStrategy.value },
    costSettings: { ...draftCostSettings.value },
    detailedStatistics: draftDetailedStatistics.value,
  })
}
</script>

<template>
  <div v-if="open" class="settings-modal-backdrop" @click.self="emit('cancel')">
    <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
      <header class="settings-modal__header">
        <div>
          <p class="settings-modal__eyebrow">Диалог</p>
          <h2 id="settings-modal-title">Настройки</h2>
        </div>
        <button type="button" class="settings-modal__close" aria-label="Закрыть настройки" @click="emit('cancel')">×</button>
      </header>

      <div class="settings-modal__body">
        <label class="settings-modal__field">
          <span>ID модели</span>
          <input v-model="draftModelId" type="text" autocomplete="off" spellcheck="false" :placeholder="defaultModel">
        </label>
        <p class="settings-modal__hint">По умолчанию: <code>{{ defaultModel }}</code></p>

        <label class="settings-modal__field">
          <span>Размер контекстного окна, токенов</span>
          <input v-model="draftContextLimit" type="number" min="1" step="1" placeholder="Не задано">
        </label>

        <label class="settings-modal__field">
          <span>Стратегия управления контекстом</span>
          <select v-model="draftStrategy.strategy">
            <option value="summary">Summary</option>
            <option value="sliding_window">Sliding Window</option>
            <option value="sticky_facts">Sticky Facts</option>
            <option value="off">Выключено</option>
          </select>
        </label>

        <label v-if="draftStrategy.strategy === 'summary'" class="settings-modal__field">
          <span>Порог Summary, сообщений</span>
          <input v-model.number="draftStrategy.messageThreshold" type="number" min="12" step="1">
        </label>
        <label v-else-if="draftStrategy.strategy === 'sliding_window' || draftStrategy.strategy === 'sticky_facts'" class="settings-modal__field">
          <span>Последних сообщений</span>
          <input v-model.number="draftStrategy.windowSize" type="number" min="1" step="1">
        </label>
        <p class="settings-modal__hint">Summary сохраняет сводку старой истории, Sliding Window оставляет только хвост, Sticky Facts добавляет ключевые данные к хвосту.</p>

        <label class="settings-modal__toggle">
          <input v-model="draftCostSettings.enabled" type="checkbox">
          <span>Подсчёт стоимости использования</span>
        </label>
        <div v-if="draftCostSettings.enabled" class="settings-modal__prices">
          <label class="settings-modal__field"><span>Входные токены, ₽ / 1 млн</span><input v-model="draftCostSettings.inputPrice" type="text" inputmode="decimal"></label>
          <label class="settings-modal__field"><span>Выходные токены, ₽ / 1 млн</span><input v-model="draftCostSettings.outputPrice" type="text" inputmode="decimal"></label>
        </div>

        <label class="settings-modal__toggle">
          <input v-model="draftDetailedStatistics" type="checkbox">
          <span>Подробная статистика токенов</span>
        </label>
        <p v-if="saveError" class="settings-modal__error" role="alert">{{ saveError }}</p>
      </div>

      <footer class="settings-modal__footer">
        <button type="button" class="settings-modal__button settings-modal__button--quiet" @click="emit('cancel')">Отмена</button>
        <button type="button" class="settings-modal__button settings-modal__button--primary" @click="save">Сохранить</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.settings-modal-backdrop { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; padding: 1rem; background: rgb(15 23 42 / 42%); }
.settings-modal { width: min(34rem, 100%); max-height: min(44rem, 100%); overflow: auto; border: 1px solid #dbe4ef; border-radius: 1rem; background: #fff; box-shadow: 0 1.5rem 4rem rgb(15 23 42 / 22%); }
.settings-modal__header, .settings-modal__footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.2rem; }
.settings-modal__header { border-bottom: 1px solid #e2e8f0; }
.settings-modal__header h2 { margin: 0; color: #172033; font-size: 1.15rem; }
.settings-modal__eyebrow { margin: 0 0 .2rem; color: #64748b; font-size: .7rem; letter-spacing: .08em; text-transform: uppercase; }
.settings-modal__close { border: 0; color: #64748b; background: transparent; font-size: 1.5rem; line-height: 1; cursor: pointer; }
.settings-modal__body { display: grid; gap: .8rem; padding: 1.2rem; }
.settings-modal__field { display: grid; gap: .35rem; color: #334155; font-size: .78rem; font-weight: 600; }
.settings-modal__field input, .settings-modal__field select { width: 100%; border: 1px solid #cbd5e1; border-radius: .5rem; padding: .55rem .65rem; color: #1e293b; background: #fff; font: inherit; font-weight: 400; }
.settings-modal__field input:focus, .settings-modal__field select:focus { outline: 2px solid #93c5fd; outline-offset: 1px; }
.settings-modal__hint { margin: -.3rem 0 .15rem; color: #64748b; font-size: .74rem; line-height: 1.4; }
.settings-modal__toggle { display: flex; align-items: center; gap: .55rem; color: #334155; font-size: .8rem; font-weight: 600; }
.settings-modal__toggle input { width: 1rem; height: 1rem; accent-color: #2563eb; }
.settings-modal__prices { display: grid; gap: .7rem; }
.settings-modal__error { margin: 0; color: #b42318; font-size: .78rem; }
.settings-modal__footer { justify-content: flex-end; border-top: 1px solid #e2e8f0; }
.settings-modal__button { border: 1px solid #cbd5e1; border-radius: .5rem; padding: .55rem .85rem; font: inherit; font-size: .8rem; font-weight: 600; cursor: pointer; }
.settings-modal__button--quiet { color: #475569; background: #fff; }
.settings-modal__button--primary { border-color: #1e293b; color: #fff; background: #1e293b; }
</style>
