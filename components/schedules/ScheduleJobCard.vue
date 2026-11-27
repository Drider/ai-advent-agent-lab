<script setup lang="ts">
import { toRef } from 'vue'
import SchedulePeriodReport from '~/components/schedules/SchedulePeriodReport.vue'
import ScheduleRunHistory from '~/components/schedules/ScheduleRunHistory.vue'
import type { ScheduledJobView } from '~/shared/scheduler'
import { formatScheduleTime, scheduleStatusClass } from '~/utils/schedule-format'

const props = withDefaults(defineProps<{
  item: ScheduledJobView
  deleting?: boolean
  deleteDisabled?: boolean
}>(), {
  deleting: false,
  deleteDisabled: false,
})

const item = toRef(props, 'item')
const emit = defineEmits<{ delete: [item: ScheduledJobView] }>()
</script>

<template>
  <article class="schedules-card">
    <header class="schedules-card__header">
      <div>
        <p class="schedules-page__eyebrow">{{ item.sourceId }} · {{ item.timezone }}</p>
        <h2>{{ item.name }}</h2>
      </div>
      <div class="schedules-card__header-actions">
        <span class="schedules-status" :class="scheduleStatusClass(item.status)">
          <span class="schedules-status__dot" aria-hidden="true" />
          {{ item.status === 'active' ? 'Работает' : 'На паузе' }}
        </span>
        <UButton
          color="error"
          variant="ghost"
          size="sm"
          icon="i-lucide-trash-2"
          :loading="props.deleting"
          :disabled="props.deleteDisabled"
          aria-label="Удалить задание"
          @click="emit('delete', item)"
        >
          Удалить
        </UButton>
      </div>
    </header>

    <div class="schedules-next-runs">
      <div>
        <span>Следующий сбор</span>
        <time :datetime="item.nextCollectAt" :title="item.nextCollectAt">{{ formatScheduleTime(item.nextCollectAt, item.timezone) }}</time>
      </div>
      <div>
        <span>Следующий отчёт</span>
        <time :datetime="item.nextReportAt" :title="item.nextReportAt">{{ formatScheduleTime(item.nextReportAt, item.timezone) }}</time>
      </div>
    </div>

    <SchedulePeriodReport v-if="item.latestReport" :report="item.latestReport" :timezone="item.timezone" />
    <p v-else class="schedules-card__no-report">Отчётов пока нет.</p>

    <ScheduleRunHistory :runs="item.lastRuns" :timezone="item.timezone" />

    <details class="schedules-card__metadata">
      <summary>Настройки задания</summary>
      <dl>
        <div><dt>ID</dt><dd><code>{{ item.id }}</code></dd></div>
        <div><dt>Сбор данных</dt><dd><code>{{ item.collectCron }}</code></dd></div>
        <div><dt>Формирование отчёта</dt><dd><code>{{ item.reportCron }}</code></dd></div>
      </dl>
    </details>
  </article>
</template>

<style scoped>
.schedules-page__eyebrow { margin: 0 0 .25rem; color: #64748b; font-size: .69rem; font-weight: 650; letter-spacing: .075em; text-transform: uppercase; }
.schedules-card { min-width: 0; border: 1px solid #dbe4ef; border-radius: .9rem; padding: clamp(.9rem, 2vw, 1.3rem); background: #fff; box-shadow: 0 3px 14px rgb(15 23 42 / 4%); }
.schedules-card__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.schedules-card__header-actions { display: flex; align-items: center; gap: .4rem; }
.schedules-card__header h2 { margin: 0; font-size: 1.15rem; }
.schedules-status { display: inline-flex; align-items: center; gap: .4rem; flex: 0 0 auto; border: 1px solid #dbe4ef; border-radius: 999px; padding: .3rem .6rem; color: #475569; background: #f8fafc; font-size: .72rem; font-weight: 600; white-space: nowrap; }
.schedules-status__dot { width: .45rem; height: .45rem; border-radius: 50%; background: #94a3b8; }
.schedules-status--active { border-color: #bbf7d0; color: #166534; background: #f0fdf4; }
.schedules-status--active .schedules-status__dot { background: #22c55e; }
.schedules-status--paused { border-color: #e2e8f0; color: #64748b; background: #f8fafc; }
.schedules-next-runs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .65rem; margin: 1rem 0; }
.schedules-next-runs > div { display: grid; gap: .2rem; border-radius: .55rem; padding: .65rem .75rem; background: #f8fafc; }
.schedules-next-runs span { color: #64748b; font-size: .68rem; }
.schedules-next-runs time { color: #263449; font-size: .8rem; font-weight: 600; }
.schedules-card__no-report { color: #64748b; font-size: .8rem; }
.schedules-card__metadata { margin-top: .8rem; border-top: 1px solid #e8edf3; padding-top: .7rem; }
.schedules-card__metadata summary { color: #475569; font-size: .75rem; font-weight: 600; cursor: pointer; }
.schedules-card__metadata dl { display: grid; gap: .4rem; margin: .65rem 0 0; }
.schedules-card__metadata dl > div { display: grid; grid-template-columns: 9rem minmax(0, 1fr); gap: .5rem; font-size: .72rem; }
.schedules-card__metadata dt { color: #64748b; }
.schedules-card__metadata dd { min-width: 0; margin: 0; color: #334155; overflow-wrap: anywhere; }
.schedules-card__metadata code { font-size: .69rem; }
@media (max-width: 640px) {
  .schedules-card__header { flex-direction: column; }
  .schedules-card__header-actions { width: 100%; justify-content: space-between; }
  .schedules-next-runs { grid-template-columns: 1fr; }
  .schedules-card__metadata dl > div { grid-template-columns: 1fr; gap: .12rem; }
}
</style>
