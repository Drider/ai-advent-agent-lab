import type { LanguageModelUsage, UIMessage } from 'ai'

export type ChatTokenUsage = Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'>
  & Partial<Pick<LanguageModelUsage, 'inputTokenDetails' | 'outputTokenDetails'>>

export interface ChatMessageMetadata {
  durationMs: number
  usage: ChatTokenUsage
  steps?: Array<{ usage: ChatTokenUsage }>
  stopReason?: 'step_limit'
  costRub?: ChatCostRub
}

export interface ChatPricing {
  inputPerMillionRub: number
  outputPerMillionRub: number
}

export interface ChatCostSettings {
  enabled: boolean
  inputPrice: string
  outputPrice: string
}

export function pricingFromSettings(settings: ChatCostSettings): ChatPricing | undefined {
  if (!settings.enabled) return undefined

  const parsePrice = (value: string): number | undefined => {
    const normalized = value.replace(/\s/gu, '').replace(',', '.')
    if (!/^\d+(?:\.\d+)?$/u.test(normalized)) return undefined
    const price = Number(normalized)
    return Number.isFinite(price) ? price : undefined
  }

  const inputPerMillionRub = parsePrice(settings.inputPrice)
  const outputPerMillionRub = parsePrice(settings.outputPrice)
  if (inputPerMillionRub === undefined || outputPerMillionRub === undefined) return undefined
  return { inputPerMillionRub, outputPerMillionRub }
}

export interface ChatCostRub {
  input: number
  output: number
  total: number
}

export function calculateChatCost(
  usage: ChatMessageMetadata['usage'],
  pricing: ChatPricing | undefined,
): ChatCostRub | undefined {
  if (!pricing || usage.inputTokens === undefined || usage.outputTokens === undefined) {
    return undefined
  }

  const input = usage.inputTokens * pricing.inputPerMillionRub / 1_000_000
  const output = usage.outputTokens * pricing.outputPerMillionRub / 1_000_000
  return { input, output, total: input + output }
}

export type ChatUIMessage = UIMessage<ChatMessageMetadata>

export function parseContextLimit(value: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(value)) return undefined
  const limit = Number(value)
  return Number.isSafeInteger(limit) ? limit : undefined
}

// Each agent step is a separate model call. The context limit applies to one
// call's input plus output, not to input accumulated across multiple calls.
export function latestContextUsage(messages: ChatUIMessage[], limit?: number) {
  const reply = [...messages].reverse().find(message => message.role === 'assistant' && message.metadata)
  const stepUsage = reply?.metadata?.steps?.at(-1)?.usage
  const inputTokens = stepUsage?.inputTokens
  if (inputTokens === undefined) return undefined
  const outputTokens = stepUsage?.outputTokens
  if (outputTokens === undefined) return { kind: 'input-only' as const, inputTokens }
  const occupiedTokens = inputTokens + outputTokens
  const measuredCall = { inputTokens, outputTokens, occupiedTokens }
  if (limit === undefined || !Number.isSafeInteger(limit) || limit <= 0) return { kind: 'measured' as const, ...measuredCall }
  return {
    kind: 'limited' as const,
    ...measuredCall,
    limit,
    percent: Math.round(occupiedTokens / limit * 1000) / 10,
    remaining: Math.max(0, limit - occupiedTokens),
  }
}

export function dialogueCostTotals(messages: ChatUIMessage[]): Map<string, number> {
  const totals = new Map<string, number>()
  let total = 0
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.metadata?.costRub) continue
    total += message.metadata.costRub.total
    totals.set(message.id, total)
  }
  return totals
}

export const CHAT_MESSAGE_STORAGE_VERSION = 1

export type ChatSessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'needs_review'
export type ChatTurnStatus = Exclude<ChatSessionStatus, 'idle'>
export type ChatMessageStatus = 'complete' | 'partial' | 'interrupted'
export type ChatStopReason =
  | 'timeout' | 'step_limit' | 'context_limit' | 'user_stopped' | 'server_restart' | 'request_error'
  | 'rate_limit' | 'provider_unavailable' | 'provider_auth' | 'invalid_model' | 'invalid_prompt' | 'connection_error' | 'agent_error'
  | 'provider_spending_limit'

export function stopReasonMessage(reason: ChatStopReason | undefined): string {
  switch (reason) {
    case 'timeout': return 'Запрос остановлен по лимиту времени. Текущий лимит — 10 минут; можно продолжить с сохранённой истории.'
    case 'step_limit': return 'Операция завершена не полностью: агент достиг лимита шагов. Нажмите «Продолжить», чтобы возобновить её с сохранённой истории.'
    case 'context_limit': return 'Контекст модели переполнен. Повторите запрос; если ошибка сохранится, начните новый диалог с кратким описанием задачи.'
    case 'user_stopped': return 'Вы остановили генерацию. Можно продолжить с сохранённой истории.'
    case 'server_restart': return 'Работа прервалась при перезапуске сервера. Можно продолжить с сохранённой истории.'
    case 'request_error': return 'Не удалось подготовить запрос. Продолжение может снова завершиться ошибкой.'
    case 'rate_limit': return 'Провайдер ограничил частоту запросов. Подождите и попробуйте продолжить.'
    case 'provider_spending_limit': return 'В polza.ai достигнут лимит расходов, установленный в дашборде. Проверьте лимит; после его изменения можно продолжить диалог.'
    case 'provider_unavailable': return 'Сервис модели временно недоступен. Попробуйте продолжить позже.'
    case 'provider_auth': return 'Провайдер отклонил доступ. Проверьте API-ключ: продолжение без исправления снова завершится ошибкой.'
    case 'invalid_model': return 'Провайдер отклонил модель или параметры запроса. Проверьте настройки модели перед продолжением.'
    case 'invalid_prompt': return 'Приложение неверно сформировало запрос. Обновите страницу и попробуйте продолжить; если ошибка повторится, требуется исправление.'
    case 'connection_error': return 'Соединение с моделью оборвалось. Можно попробовать продолжить.'
    case 'agent_error': return 'Агент завершился с ошибкой. Попробуйте продолжить; если ошибка повторится, проверьте диагностический лог.'
    default: return 'Причина остановки не сохранена. Попробуйте продолжить; если ошибка повторится, проверьте диагностический лог.'
  }
}

export interface SessionSummary {
  id: string
  runLogId: string
  title: string
  createdAt: string
  updatedAt: string
  lastOpenedAt?: string
  status: ChatSessionStatus
  revision: number
}

export interface SessionTurnSummary {
  id: string
  sessionId: string
  requestId: string
  sourceTurnId?: string
  position: number
  status: ChatTurnStatus
  stopReason?: ChatStopReason
  continuation?: 'safe' | 'needs_review' | 'not_available'
  modelId: string
  startedAt: string
  finishedAt?: string
  updatedAt: string
}

export interface SessionDetail extends SessionSummary {
  messages: ChatUIMessage[]
  lastTurn: SessionTurnSummary | null
  modelId: string | null
}

export const DEFAULT_CHAT_MODEL = 'deepseek/deepseek-v4.1-flash'
export const MAX_LAST_USER_MESSAGE_LENGTH = 10_000
export const MAX_MODEL_ID_LENGTH = 200

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export type ChatRequestBody =
  | {
      kind: 'message'
      sessionId: string
      requestId: string
      model?: string
      pricing?: ChatPricing
      message: UIMessage
    }
  | {
      kind: 'continue'
      sessionId: string
      requestId: string
      sourceTurnId: string
      message: UIMessage
      model?: string
      pricing?: ChatPricing
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validatePricing(input: unknown): ChatPricing | undefined {
  if (input === undefined) return undefined
  if (!isRecord(input)
    || typeof input.inputPerMillionRub !== 'number'
    || !Number.isFinite(input.inputPerMillionRub)
    || input.inputPerMillionRub < 0
    || typeof input.outputPerMillionRub !== 'number'
    || !Number.isFinite(input.outputPerMillionRub)
    || input.outputPerMillionRub < 0) {
    throw new Error('pricing must contain non-negative finite ruble rates')
  }
  return {
    inputPerMillionRub: input.inputPerMillionRub,
    outputPerMillionRub: input.outputPerMillionRub,
  }
}

function isUIMessageLike(value: unknown): value is UIMessage {
  if (!isRecord(value)) {
    return false
  }

  const partsAreWellFormed = Array.isArray(value.parts)
    && value.parts.every((part) => {
      if (!isRecord(part) || typeof part.type !== 'string') {
        return false
      }

      return part.type !== 'text' || typeof part.text === 'string'
    })

  return typeof value.id === 'string'
    && value.id.length > 0
    && (value.role === 'user' || value.role === 'assistant' || value.role === 'system')
    && partsAreWellFormed
}

function getMessageText(message: UIMessage): string {
  return message.parts
    .filter((part): part is Extract<UIMessage['parts'][number], { type: 'text' }> => {
      return part.type === 'text' && typeof part.text === 'string'
    })
    .map(part => part.text)
    .join('')
}

// Нормализует ID модели, который приходит из интерфейса или API.
export function validateModelId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('model must be a non-empty ID without spaces (max 200 characters)')
  }

  const model = input.trim()
  if (!model || model.length > MAX_MODEL_ID_LENGTH || /\s/u.test(model)) {
    throw new Error('model must be a non-empty ID without spaces (max 200 characters)')
  }

  return model
}

// Проверяет дешёвые ограничения запроса до обращения к платной модели.
export function validateChatRequest(input: unknown): ChatRequestBody {
  if (!isRecord(input)) {
    throw new Error('Request body must be an object')
  }

  if (input.kind !== 'message' && input.kind !== 'continue') {
    throw new Error('kind must be either message or continue')
  }

  if (typeof input.sessionId !== 'string' || !UUID_PATTERN.test(input.sessionId)) {
    throw new Error('sessionId must be a UUID')
  }

  if (typeof input.requestId !== 'string' || !UUID_PATTERN.test(input.requestId)) {
    throw new Error('requestId must be a UUID')
  }

  if ('messages' in input || 'runId' in input) {
    throw new Error('client-supplied history is not accepted')
  }

  const model = input.model === undefined ? undefined : validateModelId(input.model)
  const pricing = validatePricing(input.pricing)

  if (!isUIMessageLike(input.message)) {
    throw new Error('messages must contain valid UIMessage entries')
  }
  if (input.message.role !== 'user') {
    throw new Error('message must be a user UIMessage')
  }
  const text = getMessageText(input.message)
  if (!text.trim()) {
    throw new Error('the message must contain text')
  }
  if (text.length > MAX_LAST_USER_MESSAGE_LENGTH) {
    throw new Error('the message must be no longer than 10000 characters')
  }

  if (input.kind === 'continue') {
    if (typeof input.sourceTurnId !== 'string' || !UUID_PATTERN.test(input.sourceTurnId)) {
      throw new Error('sourceTurnId must be a UUID')
    }

    return {
      kind: 'continue',
      sessionId: input.sessionId,
      requestId: input.requestId,
      sourceTurnId: input.sourceTurnId,
      message: input.message,
      ...(model === undefined ? {} : { model }),
      ...(pricing === undefined ? {} : { pricing }),
    }
  }

  return {
    kind: 'message',
    sessionId: input.sessionId,
    requestId: input.requestId,
    message: input.message,
    ...(model === undefined ? {} : { model }),
    ...(pricing === undefined ? {} : { pricing }),
  }
}
