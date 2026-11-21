<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import type { UserProfile } from '~/shared/user-profile'

const props = defineProps<{
  profile: UserProfile | null
  defaultProfileId: string
  saving?: boolean
  deleting?: boolean
  settingDefault?: boolean
  saveError?: string | null
  conflictProfile?: UserProfile | null
  resetKey: number
}>()

const emit = defineEmits<{
  save: [payload: { id: string; expectedRevision: number; name?: string; instructions?: string }]
  create: [payload: { name: string; instructions: string }]
  delete: [profileId: string]
  setDefault: [profileId: string]
  reloadLatest: []
  dirtyChange: [dirty: boolean]
}>()

const name = shallowRef('')
const instructions = shallowRef('')
const nameError = computed(() => name.value.trim().length === 0
  ? 'Укажите название профиля.'
  : name.value.trim().length > 80 ? 'Название должно быть не длиннее 80 символов.' : null)
const instructionsError = computed(() => instructions.value.length > 16_000 ? 'Инструкции должны быть не длиннее 16 000 символов.' : null)
const dirty = computed(() => props.profile
  ? name.value !== props.profile.name || instructions.value !== props.profile.instructions
  : name.value.length > 0 || instructions.value.length > 0)
const canSave = computed(() => !nameError.value && !instructionsError.value && dirty.value && !props.saving && !props.deleting)

function resetFields(): void {
  name.value = props.profile?.name ?? ''
  instructions.value = props.profile?.instructions ?? ''
}

watch(() => [props.profile?.id, props.resetKey] as const, resetFields, { immediate: true })
watch(dirty, value => emit('dirtyChange', value), { immediate: true })

function save(): void {
  if (!canSave.value) return
  const nextName = name.value.trim()
  if (!props.profile) {
    emit('create', { name: nextName, instructions: instructions.value })
    return
  }
  emit('save', {
    id: props.profile.id,
    expectedRevision: props.profile.revision,
    ...(nextName === props.profile.name ? {} : { name: nextName }),
    ...(instructions.value === props.profile.instructions ? {} : { instructions: instructions.value }),
  })
}
</script>

<template>
  <section class="profile-editor" aria-labelledby="profile-editor-title">
    <div class="profile-editor__heading">
      <div>
        <p class="profile-editor__eyebrow">Настройки поведения агента</p>
        <h2 id="profile-editor-title">{{ props.profile ? 'Редактировать профиль' : 'Новый профиль' }}</h2>
      </div>
      <span v-if="props.profile" class="profile-editor__revision">Ревизия {{ props.profile.revision }}</span>
    </div>

    <label class="profile-editor__field" for="user-profile-name">
      <span>Название</span>
      <UInput id="user-profile-name" v-model="name" maxlength="80" autocomplete="off" required placeholder="Например, Краткие ответы" />
      <span v-if="nameError" class="profile-editor__field-error" role="alert">{{ nameError }}</span>
    </label>

    <label class="profile-editor__field" for="user-profile-instructions">
      <span>Дополнительные инструкции</span>
      <UTextarea id="user-profile-instructions" v-model="instructions" :rows="12" autoresize maxlength="16000" placeholder="Опишите предпочтения: стиль, формат, ограничения" />
      <span class="profile-editor__hint">{{ instructions.length.toLocaleString('ru-RU') }} / 16 000 · изменения применяются со следующего сообщения во всех диалогах с этим профилем.</span>
      <span v-if="instructionsError" class="profile-editor__field-error" role="alert">{{ instructionsError }}</span>
    </label>

    <div class="profile-editor__actions">
      <UButton color="neutral" :disabled="!canSave" :loading="props.saving" @click="save">
        {{ props.profile ? 'Сохранить изменения' : 'Создать профиль' }}
      </UButton>
      <UButton v-if="props.profile && props.profile.id !== props.defaultProfileId" color="neutral" variant="soft" :loading="props.settingDefault" :disabled="props.settingDefault || props.saving || props.deleting" @click="emit('setDefault', props.profile!.id)">
        Использовать по умолчанию
      </UButton>
      <span v-else-if="props.profile" class="profile-editor__default">Профиль используется по умолчанию для новых диалогов</span>
      <UButton v-if="props.profile" color="error" variant="soft" icon="i-lucide-trash-2" :loading="props.deleting" :disabled="props.saving || props.settingDefault || props.deleting" @click="emit('delete', props.profile!.id)">
        Удалить профиль
      </UButton>
    </div>

    <p v-if="props.saveError" class="profile-editor__error" role="alert">{{ props.saveError }}</p>
    <div v-if="props.conflictProfile" class="profile-editor__conflict" role="alert">
      <p>На сервере уже есть более новая версия, ревизия {{ props.conflictProfile.revision }}. Черновик сохранён в этой форме.</p>
      <UButton size="sm" color="neutral" variant="soft" @click="emit('reloadLatest')">Загрузить актуальную версию</UButton>
    </div>
  </section>
</template>

<style scoped>
.profile-editor { display: grid; gap: 1.2rem; border: 1px solid #dbe4ef; border-radius: 1rem; padding: clamp(1rem, 3vw, 1.5rem); background: white; }
.profile-editor__heading { display: flex; justify-content: space-between; align-items: start; gap: 1rem; }
.profile-editor__eyebrow { margin: 0 0 .25rem; color: #64748b; font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
.profile-editor h2 { margin: 0; color: #0f172a; font-size: 1.2rem; }
.profile-editor__revision { color: #64748b; font-size: .75rem; }
.profile-editor__field { display: grid; gap: .45rem; color: #334155; font-size: .82rem; font-weight: 600; }
.profile-editor__hint { color: #64748b; font-size: .73rem; font-weight: 400; line-height: 1.5; }
.profile-editor__field-error, .profile-editor__error { color: #b91c1c; font-size: .78rem; }
.profile-editor__error { margin: 0; }
.profile-editor__actions { display: flex; flex-wrap: wrap; align-items: center; gap: .55rem; }
.profile-editor__default { color: #475569; font-size: .75rem; }
.profile-editor__conflict { display: grid; justify-items: start; gap: .55rem; border-radius: .7rem; padding: .8rem; color: #7c2d12; background: #fff7ed; font-size: .8rem; }
.profile-editor__conflict p { margin: 0; }
</style>
