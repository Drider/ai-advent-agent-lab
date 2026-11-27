export class CronDate {
  readonly minute: number
  readonly hour: number
  readonly day: number
  readonly month: number
  readonly weekday: number

  constructor(date: Date, timezone: string) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    }).formatToParts(date)
    const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
    this.minute = Number(values.minute)
    this.hour = Number(values.hour) % 24
    this.day = Number(values.day)
    this.month = Number(values.month)
    const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
    this.weekday = weekdays[values.weekday!]!
  }
}
