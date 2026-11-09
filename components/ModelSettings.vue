<script setup lang="ts">
defineProps<{
  modelValue: string
  defaultModel: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <div class="model-settings">
    <div class="model-settings__heading">
      <UIcon name="i-lucide-sliders-horizontal" class="model-settings__icon" />
      <div>
        <h2>Модель</h2>
        <p>Укажите ID модели для следующего запроса.</p>
      </div>
    </div>

    <label class="model-settings__label" for="model-id">ID модели</label>
    <UInput
      id="model-id"
      :model-value="modelValue"
      size="lg"
      icon="i-lucide-cpu"
      autocomplete="off"
      spellcheck="false"
      placeholder="например, deepseek/deepseek-v4.1-flash"
      @update:model-value="emit('update:modelValue', $event)"
    />
    <p class="model-settings__hint">
      По умолчанию: <code>{{ defaultModel }}</code>
    </p>
  </div>
</template>
