<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import type { UserProfileSummary } from '~/shared/user-profile'

const props = defineProps<{
  items: UserProfileSummary[]
  modelValue: string
  disabled?: boolean
  loading?: boolean
  error?: string | null
}>()

const emit = defineEmits<{
  select: [profileId: string]
}>()

const selectedId = shallowRef(props.modelValue)
watch(() => [props.modelValue, props.error] as const, () => {
  selectedId.value = props.modelValue
})

function handleChange(value: string): void {
  selectedId.value = value
  emit('select', value)
}
</script>

<template>
  <label class="profile-selector">
    <span>Профиль</span>
    <select
      :value="selectedId"
      :disabled="props.disabled || props.loading || props.items.length === 0"
      aria-label="Профиль этого диалога"
      @change="handleChange(($event.target as HTMLSelectElement).value)"
    >
      <option v-for="profile in props.items" :key="profile.id" :value="profile.id">
        {{ profile.name }}
      </option>
    </select>
    <span v-if="props.loading" class="profile-selector__hint">Загрузка…</span>
    <span v-else-if="props.error" class="profile-selector__error" role="alert">{{ props.error }}</span>
  </label>
</template>

<style scoped>
.profile-selector { display: grid; gap: .25rem; min-width: 11rem; color: #475569; font-size: .72rem; font-weight: 600; }
.profile-selector select { max-width: 15rem; border: 1px solid #cbd5e1; border-radius: .55rem; padding: .45rem 2rem .45rem .65rem; color: #0f172a; background: white; font: inherit; font-size: .84rem; }
.profile-selector select:disabled { cursor: not-allowed; opacity: .65; }
.profile-selector__hint { color: #64748b; font-weight: 400; }
.profile-selector__error { max-width: 18rem; color: #b91c1c; font-weight: 500; }
</style>
