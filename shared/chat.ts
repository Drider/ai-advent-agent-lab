import type { LanguageModelUsage, UIMessage } from 'ai'

export interface ChatMessageMetadata {
  durationMs: number
  usage: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'>
}

export type ChatUIMessage = UIMessage<ChatMessageMetadata>

export const CHAT_MESSAGE_STORAGE_VERSION = 1

export type ChatSessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'needs_review'
export type ChatTurnStatus = Exclude<ChatSessionStatus, 'idle'>
export type ChatMessageStatus = 'complete' | 'partial' | 'interrupted'

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
  modelId: string
  startedAt: string
  finishedAt?: string
  updatedAt: string
}

export interface SessionDetail extends SessionSummary {
  messages: ChatUIMessage[]
  lastTurn: SessionTurnSummary | null
}

export const DEFAULT_CHAT_MODEL = 'deepseek/deepseek-v4.1-flash'
export const MAX_CHAT_MESSAGES = 100
export const MAX_LAST_USER_MESSAGE_LENGTH = 10_000
export const MAX_MODEL_ID_LENGTH = 200
export const MAX_CHAT_CONTEXT_BYTES = 256 * 1024

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export type ChatRequestBody =
  | {
      kind: 'message'
      sessionId: string
      requestId: string
      model?: string
      message: UIMessage
    }
  | {
      kind: 'continue'
      sessionId: string
      requestId: string
      sourceTurnId: string
      model?: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
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

  if (input.kind === 'continue') {
    if (typeof input.sourceTurnId !== 'string' || !UUID_PATTERN.test(input.sourceTurnId)) {
      throw new Error('sourceTurnId must be a UUID')
    }

    return {
      kind: 'continue',
      sessionId: input.sessionId,
      requestId: input.requestId,
      sourceTurnId: input.sourceTurnId,
      ...(model === undefined ? {} : { model }),
    }
  }

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

  return {
    kind: 'message',
    sessionId: input.sessionId,
    requestId: input.requestId,
    message: input.message,
    ...(model === undefined ? {} : { model }),
  }
}
