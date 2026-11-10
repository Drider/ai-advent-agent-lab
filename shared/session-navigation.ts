import type { SessionSummary } from './chat'

export function selectInitialSession(options: {
  preferredSessionId?: string
  items: SessionSummary[]
}): string | null {
  if (options.preferredSessionId) {
    return options.preferredSessionId
  }

  return [...options.items]
    .sort((left, right) => {
      const updated = right.updatedAt.localeCompare(left.updatedAt)
      return updated === 0 ? right.id.localeCompare(left.id) : updated
    })
    .at(0)?.id ?? null
}
