<script setup lang="ts">
import { computed } from 'vue'
import { pricingFromSettings, type ChatCostSettings } from '~/shared/chat'

const settings = defineModel<ChatCostSettings>({ required: true })
const hasPricing = computed(() => pricingFromSettings(settings.value) !== undefined)

function updatePrice(field: 'inputPrice' | 'outputPrice', event: Event): void {
  settings.value = { ...settings.value, [field]: (event.target as HTMLInputElement).value }
}
</script>

<template>
  <section class="chat-cost-settings" aria-label="Подсчёт стоимости использования">
    <label class="chat-cost-settings__toggle">
      <input
        type="checkbox"
        :checked="settings.enabled"
        @change="settings = { ...settings, enabled: ($event.target as HTMLInputElement).checked }"
      >
      <span>Подсчёт стоимости использования</span>
    </label>

    <details class="chat-cost-settings__details">
      <summary>Параметры стоимости</summary>
      <p class="chat-cost-settings__hint">Цены Polza AI за 1 млн текстовых токенов</p>

      <label class="chat-cost-settings__field" for="chat-cost-input-price">
        Входные токены
        <span class="chat-cost-settings__input-row">
          <input
            id="chat-cost-input-price"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :value="settings.inputPrice"
            placeholder="0,00"
            @input="updatePrice('inputPrice', $event)"
          >
          <span>₽ / 1 млн</span>
        </span>
      </label>

      <label class="chat-cost-settings__field" for="chat-cost-output-price">
        Выходные токены
        <span class="chat-cost-settings__input-row">
          <input
            id="chat-cost-output-price"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :value="settings.outputPrice"
            placeholder="0,00"
            @input="updatePrice('outputPrice', $event)"
          >
          <span>₽ / 1 млн</span>
        </span>
      </label>
    </details>

    <p v-if="settings.enabled && !hasPricing" class="chat-cost-settings__notice" role="status">
      Введите обе цены, чтобы считать новые запросы.
    </p>
  </section>
</template>

<style scoped>
.chat-cost-settings {
  display: grid;
  gap: 0.75rem;
  border-bottom: 1px solid #e2e8f0;
  padding: 0.1rem 0.25rem 1rem;
}

.chat-cost-settings__toggle {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  color: #334155;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
}

.chat-cost-settings__toggle input {
  width: 1rem;
  height: 1rem;
  flex: 0 0 auto;
  accent-color: #2563eb;
}

.chat-cost-settings__details {
  border: 1px solid #e2e8f0;
  border-radius: 0.55rem;
  padding: 0.65rem 0.75rem;
  background: #fff;
}

.chat-cost-settings__details summary {
  color: #475569;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.chat-cost-settings__hint,
.chat-cost-settings__notice {
  margin: 0;
  color: #64748b;
  font-size: 0.75rem;
  line-height: 1.4;
}

.chat-cost-settings__hint {
  padding: 0.8rem 0 0.25rem;
}

.chat-cost-settings__field {
  display: grid;
  gap: 0.3rem;
  margin-top: 0.7rem;
  color: #475569;
  font-size: 0.76rem;
}

.chat-cost-settings__input-row {
  display: flex;
  align-items: center;
  overflow: hidden;
  border: 1px solid #cbd5e1;
  border-radius: 0.45rem;
  background: #fff;
}

.chat-cost-settings__input-row:focus-within {
  outline: 2px solid #93c5fd;
  outline-offset: 1px;
}

.chat-cost-settings__input-row input {
  width: 100%;
  min-width: 0;
  border: 0;
  padding: 0.5rem 0.6rem;
  color: #334155;
  background: transparent;
  font-size: 0.8rem;
  outline: none;
}

.chat-cost-settings__input-row > span {
  flex: 0 0 auto;
  padding-right: 0.6rem;
  color: #64748b;
  font-size: 0.7rem;
}
</style>
