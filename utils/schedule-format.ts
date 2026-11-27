import type { PeriodReport, SchedulerRunStatus } from '~/shared/scheduler'

export function formatScheduleTime(value: string, timezone: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  try {
    return new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date)
  } catch {
    return value
  }
}

export function formatSchedulePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2) ?? String(payload)
  } catch {
    return String(payload)
  }
}

export function scheduleRunStatusLabel(status: SchedulerRunStatus): string {
  return {
    running: 'выполняется',
    completed: 'успешно',
    failed: 'ошибка',
    missed: 'пропущен',
  }[status]
}

export function scheduleReportStatusLabel(status: PeriodReport['status']): string {
  return { running: 'собирается', completed: 'готов', failed: 'ошибка' }[status]
}

export function scheduleStatusClass(status: string): string {
  return `schedules-status--${status}`
}
