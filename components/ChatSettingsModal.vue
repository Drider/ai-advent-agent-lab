<script setup lang="ts">
import { ref, watch } from 'vue'
import { parseContextLimit, type ChatCostSettings, type ChatContextStrategySettings } from '~/shared/chat'
import { modelConfigurationNameKey, type ModelConfiguration, type ModelConfigurationSaveRequest } from '~/shared/model-config'
import InvariantPanel from '~/components/InvariantPanel.vue'
import type { Invariant, InvariantChange } from '~/shared/invariant'

const props = defineProps<{
  open: boolean
  modelId: string
  contextLimit: string
  defaultModel: string
  contextStrategy: ChatContextStrategySettings
  costSettings: ChatCostSettings
  detailedStatistics: boolean
  saveError?: string | null
  modelConfigurations: ModelConfiguration[]
  configurationLoading?: boolean
  configurationSaving?: boolean
  configurationDeletingId?: string | null
  configurationError?: string | null
  configurationSaveError?: string | null
  configurationDeleteError?: string | null
  invariants: Invariant[]
  invariantChanges: InvariantChange[]
  invariantsLoading?: boolean
  invariantError?: string | null
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
  saveConfiguration: [payload: ModelConfigurationSaveRequest]
  deleteConfiguration: [id: string]
}>()

const draftModelId = ref('')
const draftContextLimit = ref('')
const draftStrategy = ref<ChatContextStrategySettings>({ ...props.contextStrategy })
const draftCostSettings = ref<ChatCostSettings>({ ...props.costSettings })
const draftDetailedStatistics = ref(false)
const draftConfigurationName = ref('')
const draftSelectedConfigurationId = ref<string | null>(null)
const pendingDeleteId = ref<string | null>(null)
const pendingDeleteName = ref<string | null>(null)

function selectedConfigurationId(): string | undefined {
  if (draftSelectedConfigurationId.value
    && props.modelConfigurations.some(configuration => configuration.id === draftSelectedConfigurationId.value)) {
    return draftSelectedConfigurationId.value
  }
  const name = modelConfigurationNameKey(draftConfigurationName.value.trim())
  return props.modelConfigurations.find(configuration => modelConfigurationNameKey(configuration.name) === name)?.id
}

function configurationStrategyLabel(configuration: ModelConfiguration): string {
  switch (configuration.contextStrategy.strategy) {
    case 'sliding_window': return `Sliding Window · ${configuration.contextStrategy.windowSize}`
    case 'sticky_facts': return `Sticky Facts · ${configuration.contextStrategy.windowSize}`
    case 'off': return 'Выключено'
    default: return `Summary · ${configuration.contextStrategy.messageThreshold}`
  }
}

function applyConfiguration(configuration: ModelConfiguration): void {
  draftSelectedConfigurationId.value = configuration.id
  draftConfigurationName.value = configuration.name
  draftModelId.value = configuration.modelId
  draftContextLimit.value = configuration.contextWindowTokens === undefined ? '' : String(configuration.contextWindowTokens)
  draftStrategy.value = { ...configuration.contextStrategy }
  draftCostSettings.value = { ...configuration.costSettings }
  draftDetailedStatistics.value = configuration.detailedStatistics
  pendingDeleteId.value = null
  pendingDeleteName.value = null
}

function requestConfigurationDelete(configuration: ModelConfiguration): void {
  pendingDeleteId.value = configuration.id
  pendingDeleteName.value = configuration.name
}

function confirmConfigurationDelete(configuration: ModelConfiguration): void {
  emit('deleteConfiguration', configuration.id)
}

function cancelConfigurationDelete(): void {
  pendingDeleteId.value = null
  pendingDeleteName.value = null
}

function saveConfiguration(): void {
  const name = draftConfigurationName.value.trim()
  const contextWindowTokens = draftContextLimit.value === '' ? undefined : parseContextLimit(draftContextLimit.value)
  if (!name || !draftModelId.value.trim() || (draftContextLimit.value !== '' && contextWindowTokens === undefined)) return
  emit('saveConfiguration', {
    name,
    configuration: {
      modelId: draftModelId.value,
      ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
      contextStrategy: { ...draftStrategy.value },
      costSettings: { ...draftCostSettings.value },
      detailedStatistics: draftDetailedStatistics.value,
    },
  })
}

function resetDraft(): void {
  draftModelId.value = props.modelId
  draftContextLimit.value = props.contextLimit
  draftStrategy.value = { ...props.contextStrategy }
  draftCostSettings.value = { ...props.costSettings }
  draftDetailedStatistics.value = props.detailedStatistics
  draftConfigurationName.value = ''
  draftSelectedConfigurationId.value = null
  pendingDeleteId.value = null
  pendingDeleteName.value = null
}

watch(() => props.modelConfigurations.map(configuration => configuration.id), ids => {
  const deletedId = pendingDeleteId.value
  if (!deletedId || ids.includes(deletedId)) return
  pendingDeleteId.value = null
  const deletedName = pendingDeleteName.value
  pendingDeleteName.value = null
  if (draftSelectedConfigurationId.value === deletedId
    || (deletedName && modelConfigurationNameKey(draftConfigurationName.value.trim()) === modelConfigurationNameKey(deletedName))) {
    draftSelectedConfigurationId.value = null
    draftConfigurationName.value = ''
  }
})

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
        <section class="settings-modal__configurations" aria-labelledby="saved-configurations-title">
          <div class="settings-modal__section-heading">
            <h3 id="saved-configurations-title">Сохранённые конфигурации</h3>
            <span>{{ props.modelConfigurations.length }}</span>
          </div>
          <p class="settings-modal__hint">Выберите профиль, чтобы подставить его параметры в поля ниже. Нажмите «Сохранить», чтобы применить их к диалогу.</p>
          <p v-if="props.configurationLoading && props.modelConfigurations.length === 0" class="settings-modal__empty">Загружаем конфигурации…</p>
          <p v-else-if="props.configurationError" class="settings-modal__empty">Не удалось загрузить список конфигураций.</p>
          <p v-else-if="props.modelConfigurations.length === 0" class="settings-modal__empty">Сохранённых конфигураций пока нет.</p>
          <article
            v-for="configuration in props.modelConfigurations"
            :key="configuration.id"
            class="settings-modal__configuration"
            :class="{ 'settings-modal__configuration--selected': selectedConfigurationId() === configuration.id }"
          >
            <div class="settings-modal__configuration-copy">
              <strong>{{ configuration.name }}</strong>
              <code>{{ configuration.modelId }}</code>
              <dl>
                <div><dt>Контекст</dt><dd>{{ configuration.contextWindowTokens?.toLocaleString('ru-RU') ?? 'не задан' }}</dd></div>
                <div><dt>Стратегия</dt><dd>{{ configurationStrategyLabel(configuration) }} · окно {{ configuration.contextStrategy.windowSize }} · порог {{ configuration.contextStrategy.messageThreshold }}</dd></div>
                <div><dt>Стоимость</dt><dd>{{ configuration.costSettings.enabled ? 'включена' : 'выключена' }} · вход {{ configuration.costSettings.inputPrice || '—' }} / выход {{ configuration.costSettings.outputPrice || '—' }} ₽ за 1 млн</dd></div>
                <div><dt>Статистика</dt><dd>{{ configuration.detailedStatistics ? 'подробная' : 'обычная' }}</dd></div>
              </dl>
            </div>
            <div class="settings-modal__configuration-actions">
              <button type="button" class="settings-modal__button settings-modal__button--quiet" @click="applyConfiguration(configuration)">Подставить</button>
              <template v-if="pendingDeleteId === configuration.id">
                <button
                  type="button"
                  class="settings-modal__button settings-modal__button--danger"
                  :disabled="props.configurationDeletingId === configuration.id"
                  @click="confirmConfigurationDelete(configuration)"
                >{{ props.configurationDeletingId === configuration.id ? 'Удаляем…' : 'Подтвердить удаление' }}</button>
                <button type="button" class="settings-modal__button settings-modal__button--quiet" @click="cancelConfigurationDelete">Отмена</button>
              </template>
              <button v-else type="button" class="settings-modal__button settings-modal__button--quiet" @click="requestConfigurationDelete(configuration)">Удалить</button>
            </div>
          </article>
          <p v-if="props.configurationDeleteError" class="settings-modal__error" role="alert">{{ props.configurationDeleteError }}</p>
          <p v-if="props.configurationError" class="settings-modal__error" role="alert">{{ props.configurationError }}</p>
          <p v-if="props.configurationSaveError" class="settings-modal__error" role="alert">{{ props.configurationSaveError }}</p>
        </section>

        <InvariantPanel
          :invariants="props.invariants"
          :changes="props.invariantChanges"
          :loading="props.invariantsLoading"
          :error="props.invariantError"
        />

        <section class="settings-modal__save-configuration" aria-labelledby="save-configuration-title">
          <h3 id="save-configuration-title">Сохранить текущие значения</h3>
          <label class="settings-modal__field">
            <span>Название конфигурации</span>
            <input v-model="draftConfigurationName" type="text" maxlength="80" placeholder="Например, Быстрый анализ">
          </label>
          <button
            type="button"
            class="settings-modal__button settings-modal__button--quiet"
            :disabled="props.configurationSaving || !draftConfigurationName.trim() || !draftModelId.trim() || (draftContextLimit !== '' && !parseContextLimit(draftContextLimit))"
            @click="saveConfiguration"
          >{{ props.configurationSaving ? 'Сохраняем…' : selectedConfigurationId() ? 'Обновить конфигурацию' : 'Сохранить конфигурацию' }}</button>
          <p class="settings-modal__hint">Существующая конфигурация с таким именем будет обновлена.</p>
        </section>

        <label class="settings-modal__field">
          <span>ID модели</span>
          <input v-model="draftModelId" type="text" autocomplete="off" spellcheck="false" :placeholder="defaultModel">
        </label>
        <p class="settings-modal__hint">По умолчанию: <code>{{ defaultModel }}</code></p>

        <label class="settings-modal__field">
          <span>Размер контекстного окна, токенов</span>
          <input :value="draftContextLimit" type="number" min="1" step="1" placeholder="Не задано" @input="draftContextLimit = ($event.target as HTMLInputElement).value">
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
.settings-modal__configurations, .settings-modal__save-configuration { display: grid; gap: .65rem; padding-bottom: .85rem; border-bottom: 1px solid #e2e8f0; }
.settings-modal__section-heading { display: flex; align-items: center; justify-content: space-between; gap: .6rem; }
.settings-modal__section-heading h3, .settings-modal__save-configuration h3 { margin: 0; color: #172033; font-size: .88rem; }
.settings-modal__section-heading > span { display: grid; min-width: 1.4rem; height: 1.4rem; place-items: center; border-radius: 999px; color: #475569; background: #eaf0f7; font-size: .7rem; }
.settings-modal__empty { margin: 0; color: #64748b; font-size: .76rem; }
.settings-modal__configuration { display: grid; gap: .65rem; padding: .75rem; border: 1px solid #dbe4ef; border-radius: .65rem; background: #fbfdff; }
.settings-modal__configuration--selected { border-color: #7aa9e8; background: #f3f8ff; }
.settings-modal__configuration-copy { display: grid; gap: .3rem; min-width: 0; color: #334155; font-size: .75rem; }
.settings-modal__configuration-copy > strong { color: #172033; font-size: .82rem; }
.settings-modal__configuration-copy > code { overflow-wrap: anywhere; color: #475569; }
.settings-modal__configuration-copy dl { display: grid; gap: .22rem; margin: .1rem 0 0; }
.settings-modal__configuration-copy dl > div { display: grid; grid-template-columns: 5.7rem minmax(0, 1fr); gap: .4rem; }
.settings-modal__configuration-copy dt { color: #64748b; }
.settings-modal__configuration-copy dd { margin: 0; overflow-wrap: anywhere; }
.settings-modal__configuration-actions { display: flex; flex-wrap: wrap; gap: .4rem; }
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
.settings-modal__button--danger { border-color: #fecaca; color: #b42318; background: #fff7f7; }
.settings-modal__button:disabled { opacity: .6; cursor: not-allowed; }
</style>
