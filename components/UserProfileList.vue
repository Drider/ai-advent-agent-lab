<script setup lang="ts">
import type { UserProfileSummary } from '~/shared/user-profile'

defineProps<{
  items: UserProfileSummary[]
  selectedId: string | null
  defaultProfileId: string
  loading?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{
  select: [profileId: string]
  create: []
}>()
</script>

<template>
  <aside class="profile-list" aria-label="Список профилей">
    <p v-if="loading" class="profile-list__state">Загрузка профилей…</p>
    <p v-else-if="items.length === 0" class="profile-list__state">Профилей пока нет.</p>
    <div v-else class="profile-list__items">
      <button
        v-for="profile in items"
        :key="profile.id"
        type="button"
        class="profile-list__item"
        :class="{ 'profile-list__item--selected': profile.id === selectedId }"
        :disabled="disabled"
        :aria-current="profile.id === selectedId ? 'true' : undefined"
        @click="emit('select', profile.id)"
      >
        <span class="profile-list__name">{{ profile.name }}</span>
        <span v-if="profile.id === defaultProfileId" class="profile-list__badge">По умолчанию</span>
        <span class="profile-list__revision">Ревизия {{ profile.revision }}</span>
      </button>
    </div>
    <UButton class="profile-list__create" color="neutral" variant="soft" icon="i-lucide-plus" :disabled="disabled" @click="emit('create')">
      Создать профиль
    </UButton>
  </aside>
</template>

<style scoped>
.profile-list { display: grid; align-content: start; gap: .55rem; }
.profile-list__items { display: grid; gap: .35rem; }
.profile-list__item { display: grid; gap: .3rem; width: 100%; border: 1px solid transparent; border-radius: .7rem; padding: .75rem; text-align: left; color: #334155; background: transparent; font: inherit; cursor: pointer; }
.profile-list__item:hover, .profile-list__item--selected { border-color: #dbe4ef; background: white; }
.profile-list__name { overflow-wrap: anywhere; font-weight: 650; }
.profile-list__badge { width: fit-content; border-radius: 999px; padding: .12rem .4rem; color: #475569; background: #e2e8f0; font-size: .68rem; }
.profile-list__revision, .profile-list__state { color: #64748b; font-size: .73rem; }
.profile-list__state { margin: .3rem; }
.profile-list__create { justify-self: start; margin-top: .35rem; }
</style>
