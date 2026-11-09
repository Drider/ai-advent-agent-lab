import type { LanguageModelUsage, UIMessage } from 'ai'

export interface ChatMessageMetadata {
  durationMs: number
  usage: Pick<LanguageModelUsage, 'inputTokens' | 'outputTokens' | 'totalTokens'>
}

export type ChatUIMessage = UIMessage<ChatMessageMetadata>

export const DEFAULT_CHAT_MODEL = 'deepseek/deepseek-v4.1-flash'
export const MAX_CHAT_MESSAGES = 100
export const MAX_LAST_USER_MESSAGE_LENGTH = 10_000
export const MAX_MODEL_ID_LENGTH = 200

const ISO_RUN_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export interface ChatRequestBody {
  messages: UIMessage[]
  model?: string
  runId?: string
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

  if (!Array.isArray(input.messages)) {
    throw new Error('messages must be an array')
  }

  if (input.messages.length > MAX_CHAT_MESSAGES) {
    throw new Error('messages must contain no more than 100 entries')
  }

  if (!input.messages.every(isUIMessageLike)) {
    throw new Error('messages must contain valid UIMessage entries')
  }

  const messages = input.messages
  const lastUserMessage = [...messages]
    .reverse()
    .find(message => message.role === 'user')

  if (lastUserMessage) {
    const text = getMessageText(lastUserMessage)
    if (!text.trim()) {
      throw new Error('the last user message must contain text')
    }

    if (text.length > MAX_LAST_USER_MESSAGE_LENGTH) {
      throw new Error('the last user message must be no longer than 10000 characters')
    }
  }

  const model = input.model === undefined ? undefined : validateModelId(input.model)

  if (input.runId !== undefined) {
    if (typeof input.runId !== 'string' || !ISO_RUN_ID_PATTERN.test(input.runId)) {
      throw new Error('runId must be an ISO timestamp')
    }
  }

  return {
    messages,
    ...(model === undefined ? {} : { model }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
  }
}
