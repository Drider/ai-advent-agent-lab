<script setup lang="ts">
import type { ScheduledRun } from '~/shared/scheduler'
import { formatScheduleTime, scheduleRunStatusLabel, scheduleStatusClass } from '~/utils/schedule-format'

defineProps<{
  runs: ScheduledRun[]
  timezone: string
}>()
</script>

<template>
  <details class="schedules-history">
    <summary>Последние запуски <span>· {{ runs.length }}</span></summary>
    <ul>
      <li v-for="run in runs" :key="run.id">
        <time :datetime="run.scheduledFor" :title="run.scheduledFor">{{ formatScheduleTime(run.scheduledFor, timezone) }}</time>
        <span class="schedules-status schedules-status--small" :class="scheduleStatusClass(run.status)">{{ scheduleRunStatusLabel(run.status) }}</span>
        <span v-if="run.error" class="schedules-history__error">{{ run.error }}</span>
      </li>
      <li v-if="runs.length === 0" class="schedules-history__empty">Запусков пока нет.</li>
    </ul>
  </details>
</template>

<style scoped>
.schedules-history { margin-top: .8rem; border-top: 1px solid #e8edf3; padding-top: .7rem; }
.schedules-history summary { color: #475569; font-size: .75rem; font-weight: 600; cursor: pointer; }
.schedules-history summary span { color: #94a3b8; font-weight: 400; }
.schedules-history ul { display: grid; gap: .4rem; margin: .65rem 0 0; padding: 0; list-style: none; }
.schedules-history li { display: flex; align-items: center; flex-wrap: wrap; gap: .55rem; color: #334155; font-size: .74rem; }
.schedules-history li time { min-width: min(100%, 13rem); }
.schedules-history__error { color: #b42318; font-size: .72rem; overflow-wrap: anywhere; }
.schedules-history__empty { color: #64748b !important; }
.schedules-status { display: inline-flex; align-items: center; gap: .4rem; flex: 0 0 auto; border: 1px solid #dbe4ef; border-radius: 999px; padding: .3rem .6rem; color: #475569; background: #f8fafc; font-size: .72rem; font-weight: 600; white-space: nowrap; }
.schedules-status__dot { width: .45rem; height: .45rem; border-radius: 50%; background: #94a3b8; }
.schedules-status--completed { border-color: #bbf7d0; color: #166534; background: #f0fdf4; }
.schedules-status--completed .schedules-status__dot { background: #22c55e; }
.schedules-status--running { border-color: #bfdbfe; color: #1d4ed8; background: #eff6ff; }
.schedules-status--running .schedules-status__dot { background: #3b82f6; }
.schedules-status--failed, .schedules-status--missed { border-color: #fecaca; color: #b42318; background: #fef2f2; }
.schedules-status--failed .schedules-status__dot, .schedules-status--missed .schedules-status__dot { background: #ef4444; }
.schedules-status--small { padding: .2rem .48rem; font-size: .67rem; }
</style>
