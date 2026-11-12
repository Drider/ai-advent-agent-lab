import { validateUIMessages, type UIMessage } from 'ai'
import { createSessionRepository } from '../persistence/session-repository'

export class SessionContextError extends Error {
  constructor(
    public readonly code: 'SESSION_NOT_FOUND',
    message: string,
  ) {
    super(message)
    this.name = 'SessionContextError'
  }
}

type SessionRepository = ReturnType<typeof createSessionRepository>

const MAX_MODEL_CONTEXT_CHARS = 120_000

function modelMessageSize(message: UIMessage): number {
  return JSON.stringify({ role: message.role, parts: message.parts }).length
}

function fitModelContext(messages: UIMessage[]): UIMessage[] {
  if (messages.reduce((size, message) => size + modelMessageSize(message), 0) <= MAX_MODEL_CONTEXT_CHARS) {
    return messages
  }

  // Earlier tool outputs remain in SQLite and the UI. The model receives the
  // assistant's conclusions instead of rereading every PDF extraction.
  const compacted = messages.flatMap(message => {
    if (message.role !== 'assistant') return [message]
    const parts = message.parts.filter(part => part.type === 'text' && part.text.trim())
    return parts.length ? [{ id: message.id, role: message.role, parts }] : []
  })
  if (compacted.reduce((size, message) => size + modelMessageSize(message), 0) <= MAX_MODEL_CONTEXT_CHARS) {
    return compacted
  }

  const first = compacted[0]?.role === 'user' ? compacted[0] : undefined
  const recent: UIMessage[] = []
  let size = first ? modelMessageSize(first) : 0
  for (let index = compacted.length - 1; index >= (first ? 1 : 0); index -= 1) {
    const message = compacted[index]!
    const messageSize = modelMessageSize(message)
    if (size + messageSize > MAX_MODEL_CONTEXT_CHARS) break
    recent.unshift(message)
    size += messageSize
  }
  while (recent[0]?.role === 'assistant') recent.shift()
  return first ? [first, ...recent] : recent
}

export async function buildSessionContext(
  sessionId: string,
  repository: SessionRepository,
): Promise<UIMessage[]> {
  const session = await repository.getSession(sessionId, { excludeTrailingInterruptedAssistant: true })
  if (!session) {
    throw new SessionContextError('SESSION_NOT_FOUND', `session ${sessionId} was not found`)
  }

  try {
    return await validateUIMessages<UIMessage>({ messages: fitModelContext(session.messages) })
  } catch (error) {
    throw new Error('stored chat context contains invalid UIMessage parts', { cause: error })
  }
}
