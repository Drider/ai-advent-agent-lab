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

export async function buildSessionContext(
  sessionId: string,
  repository: SessionRepository,
): Promise<UIMessage[]> {
  const session = await repository.getSession(sessionId, { excludeTrailingInterruptedAssistant: true })
  if (!session) {
    throw new SessionContextError('SESSION_NOT_FOUND', `session ${sessionId} was not found`)
  }

  try {
    return await validateUIMessages<UIMessage>({ messages: session.messages })
  } catch (error) {
    throw new Error('stored chat context contains invalid UIMessage parts', { cause: error })
  }
}
