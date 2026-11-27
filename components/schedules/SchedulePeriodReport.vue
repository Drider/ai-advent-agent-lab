<script setup lang="ts">
import type { ScheduleReportView } from '~/shared/scheduler'
import { formatSchedulePayload, formatScheduleTime, scheduleReportStatusLabel, scheduleRunStatusLabel, scheduleStatusClass } from '~/utils/schedule-format'

defineProps<{
  report: ScheduleReportView
  timezone: string
}>()
</script>

<template>
  <section class="schedules-report" aria-label="Последний отчёт">
    <header class="schedules-report__header">
      <div>
        <p class="schedules-page__eyebrow">Последний отчёт</p>
        <h3>Сводка за период</h3>
        <p class="schedules-report__period">
          <time :datetime="report.from" :title="report.from">{{ formatScheduleTime(report.from, timezone) }}</time>
          <span aria-hidden="true">—</span>
          <time :datetime="report.to" :title="report.to">{{ formatScheduleTime(report.to, timezone) }}</time>
        </p>
        <p class="schedules-report__hint">Конечная граница периода не включается.</p>
      </div>
      <span class="schedules-status" :class="scheduleStatusClass(report.status)">
        <span class="schedules-status__dot" aria-hidden="true" />
        {{ scheduleReportStatusLabel(report.status) }}
      </span>
    </header>

    <dl class="schedules-metrics">
      <div class="schedules-metric">
        <dt>Запусков</dt>
        <dd>{{ report.runCount }}</dd>
      </div>
      <div class="schedules-metric schedules-metric--success">
        <dt>Успешно</dt>
        <dd>{{ report.successCount }}</dd>
      </div>
      <div class="schedules-metric schedules-metric--failure">
        <dt>С ошибкой</dt>
        <dd>{{ report.failureCount }}</dd>
      </div>
      <div class="schedules-metric schedules-metric--missed">
        <dt>Пропущено</dt>
        <dd>{{ report.missedCount }}</dd>
      </div>
      <div class="schedules-metric schedules-metric--results">
        <dt>Результатов</dt>
        <dd>{{ report.resultCount }}</dd>
      </div>
    </dl>

    <div class="schedules-report__results-heading">
      <h4>Данные, вошедшие в отчёт</h4>
      <span v-if="report.resultCount > report.results.length">Показаны {{ report.results.length }} из {{ report.resultCount }}</span>
      <span v-else>{{ report.results.length }} {{ report.results.length === 1 ? 'результат' : 'результатов' }}</span>
    </div>
    <div v-if="report.results.length" class="schedules-results">
      <article v-for="result in report.results" :key="result.runId" class="schedules-result">
        <div class="schedules-result__header">
          <div>
            <time :datetime="result.scheduledFor" :title="result.scheduledFor">{{ formatScheduleTime(result.scheduledFor, timezone) }}</time>
            <span class="schedules-result__observed">Получено {{ formatScheduleTime(result.observedAt, timezone) }}</span>
          </div>
          <span class="schedules-status schedules-status--small" :class="scheduleStatusClass(result.status)">{{ scheduleRunStatusLabel(result.status) }}</span>
        </div>
        <pre>{{ formatSchedulePayload(result.payload) }}</pre>
        <p v-if="result.error" class="schedules-result__error">{{ result.error }}</p>
      </article>
    </div>
    <p v-else class="schedules-report__empty">В этот период данные не были сохранены.</p>

    <details v-if="report.text || report.error" class="schedules-report__details">
      <summary>{{ report.error ? 'Ошибка формирования отчёта' : 'Текст сводки' }}</summary>
      <p v-if="report.error" class="schedules-result__error">{{ report.error }}</p>
      <pre v-else>{{ report.text }}</pre>
    </details>
  </section>
</template>

<style scoped>
.schedules-page__eyebrow { margin: 0 0 .25rem; color: #64748b; font-size: .69rem; font-weight: 650; letter-spacing: .075em; text-transform: uppercase; }
.schedules-status { display: inline-flex; align-items: center; gap: .4rem; flex: 0 0 auto; border: 1px solid #dbe4ef; border-radius: 999px; padding: .3rem .6rem; color: #475569; background: #f8fafc; font-size: .72rem; font-weight: 600; white-space: nowrap; }
.schedules-status__dot { width: .45rem; height: .45rem; border-radius: 50%; background: #94a3b8; }
.schedules-status--completed { border-color: #bbf7d0; color: #166534; background: #f0fdf4; }
.schedules-status--completed .schedules-status__dot { background: #22c55e; }
.schedules-status--running { border-color: #bfdbfe; color: #1d4ed8; background: #eff6ff; }
.schedules-status--running .schedules-status__dot { background: #3b82f6; }
.schedules-status--failed, .schedules-status--missed { border-color: #fecaca; color: #b42318; background: #fef2f2; }
.schedules-status--failed .schedules-status__dot, .schedules-status--missed .schedules-status__dot { background: #ef4444; }
.schedules-status--small { padding: .2rem .48rem; font-size: .67rem; }
.schedules-report { border: 1px solid #dbe4ef; border-radius: .7rem; padding: clamp(.8rem, 2vw, 1rem); background: #fbfdff; }
.schedules-report__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
.schedules-report__header h3 { margin: 0; font-size: 1rem; }
.schedules-report__period { display: flex; flex-wrap: wrap; gap: .3rem; margin: .35rem 0 0; color: #64748b; font-size: .76rem; }
.schedules-report__hint { margin: .3rem 0 0; color: #94a3b8; font-size: .68rem; }
.schedules-metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: .6rem; margin: 1rem 0 1.15rem; }
.schedules-metric { display: grid; gap: .12rem; border-left: 3px solid #94a3b8; border-radius: .35rem; padding: .55rem .65rem; background: #f1f5f9; }
.schedules-metric dt { color: #64748b; font-size: .68rem; }
.schedules-metric dd { margin: 0; color: #1e293b; font-size: 1.25rem; font-weight: 700; line-height: 1.2; }
.schedules-metric--success { border-color: #22c55e; background: #f0fdf4; }
.schedules-metric--failure { border-color: #ef4444; background: #fef2f2; }
.schedules-metric--missed { border-color: #f59e0b; background: #fffbeb; }
.schedules-metric--results { border-color: #3b82f6; background: #eff6ff; }
.schedules-report__results-heading { display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; margin-bottom: .55rem; }
.schedules-report__results-heading h4 { margin: 0; color: #334155; font-size: .82rem; }
.schedules-report__results-heading span { color: #64748b; font-size: .7rem; }
.schedules-results { display: grid; gap: .5rem; }
.schedules-result { min-width: 0; border: 1px solid #e2e8f0; border-radius: .55rem; padding: .65rem .75rem; background: #fff; }
.schedules-result__header { display: flex; justify-content: space-between; gap: .7rem; }
.schedules-result__header > div { display: grid; gap: .15rem; min-width: 0; }
.schedules-result__header time { color: #334155; font-size: .76rem; font-weight: 650; }
.schedules-result__observed { color: #64748b; font-size: .68rem; }
.schedules-result pre, .schedules-report__details pre { max-width: 100%; overflow: auto; margin: .55rem 0 0; border-radius: .4rem; padding: .6rem; color: #334155; background: #f8fafc; font: .72rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.schedules-result__error { margin: .5rem 0 0; color: #b42318; font-size: .74rem; line-height: 1.4; overflow-wrap: anywhere; }
.schedules-report__empty { color: #64748b; font-size: .8rem; }
.schedules-report__details { margin-top: .8rem; border-top: 1px solid #e8edf3; padding-top: .7rem; }
.schedules-report__details summary { color: #475569; font-size: .75rem; font-weight: 600; cursor: pointer; }
@media (max-width: 760px) { .schedules-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { .schedules-report__header { flex-direction: column; } }
</style>
