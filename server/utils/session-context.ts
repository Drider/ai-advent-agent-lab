import { validateUIMessages, type UIMessage } from 'ai'
import {
  MAX_CHAT_CONTEXT_BYTES,
  MAX_CHAT_MESSAGES,
} from '../../shared/chat'
import { createSessionRepository } from '../persistence/session-repository'

export class SessionContextError extends Error {
  constructor(
    public readonly code: 'SESSION_NOT_FOUND' | 'CONTEXT_LIMIT_REACHED',
    message: string,
  ) {
    super(message)
    this.name = 'SessionContextError'
  }
}

type SessionRepository = ReturnType<typeof createSessionRepository>

export async function buildSessionContext(
  sessionId: string,
  repository: SessionRepository,
): Promise<UIMessage[]> {
  const session = await repository.getSession(sessionId, { excludeTrailingInterruptedAssistant: true })
  if (!session) {
    throw new SessionContextError('SESSION_NOT_FOUND', `session ${sessionId} was not found`)
  }

  let messages = session.messages
  if (messages.length > MAX_CHAT_MESSAGES) {
    throw new SessionContextError(
      'CONTEXT_LIMIT_REACHED',
      `chat context must contain no more than ${MAX_CHAT_MESSAGES} messages`,
    )
  }

  const serialized = JSON.stringify(messages)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_CHAT_CONTEXT_BYTES) {
    throw new SessionContextError(
      'CONTEXT_LIMIT_REACHED',
      `chat context must be no larger than ${MAX_CHAT_CONTEXT_BYTES} bytes`,
    )
  }

  try {
    return await validateUIMessages<UIMessage>({ messages })
  } catch (error) {
    throw new Error('stored chat context contains invalid UIMessage parts', { cause: error })
  }
}
