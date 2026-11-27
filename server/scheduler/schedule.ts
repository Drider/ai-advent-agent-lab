import { CronDate } from './schedule-cron-date'

interface CronFields {
  minute: Set<number>
  hour: Set<number>
  day: Set<number>
  month: Set<number>
  weekday: Set<number>
  dayWildcard: boolean
  weekdayWildcard: boolean
}

function parseField(raw: string, min: number, max: number): Set<number> {
  const values = new Set<number>()
  for (const part of raw.split(',')) {
    const parts = part.split('/')
    const rangePart = parts[0] ?? ''
    const stepPart = parts[1]
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid cron step: ${raw}`)
    const range = rangePart === '*' ? [min, max] : rangePart.includes('-') ? rangePart.split('-').map(Number) : [Number(rangePart), Number(rangePart)]
    if (range.length !== 2 || range.some(value => !Number.isInteger(value)) || range[0]! < min || range[1]! > max || range[0]! > range[1]!) {
      throw new Error(`invalid cron field: ${raw}`)
    }
    for (let value = range[0]!; value <= range[1]!; value += step) values.add(value)
  }
  return values
}

function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/u)
  if (fields.length !== 5) throw new Error('cron must contain five fields')
  return {
    minute: parseField(fields[0]!, 0, 59),
    hour: parseField(fields[1]!, 0, 23),
    day: parseField(fields[2]!, 1, 31),
    month: parseField(fields[3]!, 1, 12),
    weekday: parseField(fields[4]!, 0, 7),
    dayWildcard: fields[2] === '*',
    weekdayWildcard: fields[4] === '*',
  }
}

function matches(date: Date, fields: CronFields, timezone: string): boolean {
  const local = new CronDate(date, timezone)
  const minute = local.minute
  const hour = local.hour
  const day = local.day
  const month = local.month
  const weekday = local.weekday
  const dayMatches = fields.day.has(day)
  const weekdayMatches = fields.weekday.has(weekday) || (weekday === 0 && fields.weekday.has(7))
  const calendarMatches = fields.dayWildcard && fields.weekdayWildcard
    ? true
    : fields.dayWildcard
      ? weekdayMatches
      : fields.weekdayWildcard
        ? dayMatches
        : dayMatches || weekdayMatches
  return fields.minute.has(minute) && fields.hour.has(hour) && fields.month.has(month) && calendarMatches
}

function findOccurrence(expression: string, timezone: string, reference: Date, direction: 1 | -1): Date {
  const fields = parseCron(expression)
  // Validate the IANA zone before scanning. Intl throws for an unknown zone.
  new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(reference)
  const start = new Date(reference)
  start.setUTCSeconds(0, 0)
  let cursor = new Date(start.getTime() + direction * 60_000)
  const maxMinutes = 5 * 366 * 24 * 60
  for (let index = 0; index < maxMinutes; index += 1) {
    if (matches(cursor, fields, timezone)) return cursor
    cursor = new Date(cursor.getTime() + direction * 60_000)
  }
  throw new Error('cron expression has no occurrence in the search range')
}

export function nextOccurrence(cron: string, timezone: string, after: Date): Date {
  return findOccurrence(cron, timezone, after, 1)
}

export function previousOccurrence(cron: string, timezone: string, before: Date): Date {
  return findOccurrence(cron, timezone, before, -1)
}
