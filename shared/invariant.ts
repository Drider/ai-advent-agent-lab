export const INVARIANT_CATEGORIES = ['architecture', 'decision', 'stack', 'business'] as const

export type InvariantCategory = typeof INVARIANT_CATEGORIES[number]

export interface Invariant {
  id: string
  category: InvariantCategory
  title: string
  rule: string
  forbidden: string[]
  updatedAt: string
}

export interface InvariantChange {
  id: string
  invariantId: string
  action: 'create' | 'update' | 'remove'
  before: Invariant | null
  after: Invariant | null
  changedAt: string
}

export interface InvariantSeed {
  id: string
  category: InvariantCategory
  title: string
  rule: string
  forbidden: string[]
}

export const INITIAL_INVARIANTS: InvariantSeed[] = [
  {
    id: 'stack-frontend',
    category: 'stack',
    title: 'Фронтенд',
    rule: 'Фронтенд только Vue 3 / Nuxt.',
    forbidden: [
      String.raw`from\s+['"]react['"]`,
      String.raw`\bimport\s+React\b`,
      String.raw`\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\s+(?:-\S+\s+)*react\b`,
      String.raw`\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\s+(?:-\S+\s+)*next\b`,
      String.raw`\buseState\s*\(`,
    ],
  },
  {
    id: 'storage-sqlite',
    category: 'decision',
    title: 'Хранилище',
    rule: 'SQLite используется через better-sqlite3 без ORM.',
    forbidden: [
      String.raw`@prisma/client`,
      String.raw`\bnew\s+PrismaClient\b`,
      String.raw`\b(?:npm|pnpm|yarn)\s+(?:i|install|add)\s+(?:-\S+\s+)*(?:prisma|typeorm|sequelize|mongoose|pg)\b`,
    ],
  },
  {
    id: 'server-llm',
    category: 'architecture',
    title: 'Вызовы LLM',
    rule: 'К LLM ходит только сервер; клиентский код не обращается к провайдеру напрямую.',
    forbidden: [
      String.raw`api\.openai\.com`,
      String.raw`\bcreateOpenAI\s*\(`,
    ],
  },
  {
    id: 'money-rub',
    category: 'business',
    title: 'Валюта',
    rule: 'Стоимость указывается только в рублях.',
    forbidden: [
      String.raw`\$\s*\d`,
      String.raw`\bUSD\b`,
    ],
  },
]

export type InvariantCommand =
  | { ok: true; action: 'set'; id: string; category?: InvariantCategory; rule: string }
  | { ok: true; action: 'forbid'; id: string; forbidden: string[] }
  | { ok: true; action: 'remove'; id: string }

export type InvariantCommandResult = InvariantCommand | { ok: false; error: string }

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/u
const MAX_RULE_LENGTH = 2_000
const MAX_TITLE_LENGTH = 120
const MAX_PATTERN_COUNT = 20
const MAX_PATTERN_LENGTH = 200

export function validateInvariantId(value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value.trim())) {
    throw new Error('invariant id must contain 1-80 lowercase latin letters, digits, hyphens, or underscores')
  }
  return value.trim()
}

export function validateInvariantCategory(value: unknown): InvariantCategory {
  if (typeof value !== 'string' || !INVARIANT_CATEGORIES.includes(value as InvariantCategory)) {
    throw new Error(`invariant category must be one of: ${INVARIANT_CATEGORIES.join(', ')}`)
  }
  return value as InvariantCategory
}

export function validateInvariantRule(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invariant rule must be a string')
  const rule = value.trim()
  if (rule.length < 1 || rule.length > MAX_RULE_LENGTH) {
    throw new Error(`invariant rule must be 1-${MAX_RULE_LENGTH} characters`)
  }
  return rule
}

export function validateInvariantTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invariant title must be a string')
  const title = value.trim()
  if (title.length < 1 || title.length > MAX_TITLE_LENGTH) {
    throw new Error(`invariant title must be 1-${MAX_TITLE_LENGTH} characters`)
  }
  return title
}

export function validateForbiddenPatterns(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('forbidden patterns must be an array')
  if (value.length > MAX_PATTERN_COUNT) throw new Error(`forbidden patterns must contain at most ${MAX_PATTERN_COUNT} items`)

  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(`forbidden pattern ${index + 1} must be a string`)
    if (item.length < 1 || item.length > MAX_PATTERN_LENGTH) {
      throw new Error(`forbidden pattern ${index + 1} must be 1-${MAX_PATTERN_LENGTH} characters`)
    }
    try {
      new RegExp(item, 'iu')
    } catch (error) {
      throw new Error(`forbidden pattern ${index + 1} is invalid: ${error instanceof Error ? error.message : 'invalid regex'}`)
    }
    return item
  })
}

export function checkInvariants(
  text: string,
  invariants: readonly Invariant[],
): Array<{ invariantId: string; match: string }> {
  const violations: Array<{ invariantId: string; match: string }> = []
  for (const invariant of invariants) {
    for (const pattern of invariant.forbidden) {
      const match = new RegExp(pattern, 'iu').exec(text)
      if (match) violations.push({ invariantId: invariant.id, match: match[0] })
    }
  }
  return violations
}

export function formatInvariantRefusal(
  violations: readonly { invariantId: string; match: string }[],
  invariants: readonly Invariant[],
): string {
  const byId = new Map(invariants.map(invariant => [invariant.id, invariant]))
  const details = violations.map((violation) => {
    const invariant = byId.get(violation.invariantId)
    return `- ${violation.invariantId}: ${invariant?.rule ?? 'правило недоступно'}\n  Найдено: «${violation.match || '(пустое совпадение)'}»`
  }).join('\n')
  const commandHint = violations.length === 1
    ? `/invariant set ${violations[0]!.invariantId} <категория> <новое правило>`
    : '/invariant set <id> <категория> <новое правило>'
  return `Ответ заменён кодовым отказом: нарушен инвариант.\n\n${details}\n\nПредложите решение в рамках инвариантов. Изменить правило можно только явной командой ${commandHint}.`
}

export function parseInvariantCommand(text: string): InvariantCommandResult {
  const input = text.trim()
  if (!/^\/invariant(?:\s|$)/u.test(input)) {
    return { ok: false, error: 'Команда должна начинаться с /invariant.' }
  }

  const parts = input.split(/\s+/u)
  const action = parts[1]
  if (action === 'set') {
    const id = parts[2]
    if (!id) return { ok: false, error: 'Использование: /invariant set <id> [категория] <текст правила>.' }
    const setMatch = input.match(/^\/invariant\s+set\s+\S+\s*([\s\S]*)$/u)
    const rest = setMatch?.[1]?.trim() ?? ''
    const restParts = rest.split(/\s+/u)
    const category = INVARIANT_CATEGORIES.includes(restParts[0] as InvariantCategory)
      ? restParts.shift() as InvariantCategory
      : undefined
    const rule = restParts.join(' ').trim()
    if (!rule) return { ok: false, error: 'Текст правила не должен быть пустым.' }
    try {
      return {
        ok: true,
        action,
        id: validateInvariantId(id),
        ...(category === undefined ? {} : { category }),
        rule: validateInvariantRule(rule),
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Некорректное правило.' }
    }
  }

  if (action === 'forbid') {
    const id = parts[2]
    if (!id) return { ok: false, error: 'Использование: /invariant forbid <id> <regex>; <regex>.' }
    const forbidMatch = input.match(/^\/invariant\s+forbid\s+\S+\s*([\s\S]*)$/u)
    const rawPatterns = forbidMatch?.[1]?.trim() ?? ''
    const forbidden = rawPatterns ? rawPatterns.split(';').map(pattern => pattern.trim()) : []
    try {
      return { ok: true, action, id: validateInvariantId(id), forbidden: validateForbiddenPatterns(forbidden) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Некорректный regex.' }
    }
  }

  if (action === 'remove' && parts.length === 3) {
    try {
      return { ok: true, action, id: validateInvariantId(parts[2]) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Некорректный id.' }
    }
  }

  return { ok: false, error: 'Неизвестная команда. Используйте: /invariant set, forbid или remove.' }
}
