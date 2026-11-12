import type { ChatStopReason } from '../../shared/chat'

export function classifyAgentStopReason(error: unknown): ChatStopReason {
  const record = error !== null && typeof error === 'object' ? error as Record<string, unknown> : undefined
  const name = typeof record?.name === 'string' ? record.name : ''
  const message = typeof error === 'string' ? error : typeof record?.message === 'string' ? record.message : ''
  const status = typeof record?.statusCode === 'number' ? record.statusCode : typeof record?.status === 'number' ? record.status : undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const metadata = record?.metadata && typeof record.metadata === 'object' ? record.metadata as Record<string, unknown> : undefined
  const rawMessage = typeof metadata?.raw === 'string' ? metadata.raw : ''

  if (code === 'INSUFFICIENT_BALANCE') return 'provider_spending_limit'
  if (code === 'context_length_exceeded' || /(?:maximum context length|context window|too many tokens)/iu.test(`${message} ${rawMessage}`)) return 'context_limit'
  if (name === 'TimeoutError' || /(?:timed? out|timeout)/iu.test(message)) return 'timeout'
  if (name === 'AI_InvalidPromptError' || /System messages are not allowed in the prompt or messages fields/u.test(message)) return 'invalid_prompt'
  if (/^agent stopped after \d+ steps$/u.test(message)) return 'step_limit'
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'provider_auth'
  if (status === 400 || status === 404 || status === 422) return 'invalid_model'
  if (status !== undefined && status >= 500) return 'provider_unavailable'
  if (/^(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)$/u.test(code)) return 'connection_error'
  return 'agent_error'
}
