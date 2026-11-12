import { describe, expect, it } from 'vitest'
import { classifyAgentStopReason } from '../server/utils/agent-stop-reason'
import { stopReasonMessage } from '../shared/chat'

describe('agent stop reasons', () => {
  it('separates timeouts and step limits from other failures', () => {
    expect(classifyAgentStopReason({ name: 'TimeoutError', message: 'The operation was aborted due to timeout' })).toBe('timeout')
    expect(classifyAgentStopReason(new Error('agent stopped after 10 steps'))).toBe('step_limit')
    expect(classifyAgentStopReason({ statusCode: 429 })).toBe('rate_limit')
    expect(classifyAgentStopReason({ statusCode: 401 })).toBe('provider_auth')
    expect(classifyAgentStopReason({ statusCode: 503 })).toBe('provider_unavailable')
    expect(classifyAgentStopReason({ code: 'ECONNRESET' })).toBe('connection_error')
    expect(classifyAgentStopReason({ code: 'BAD_REQUEST', message: 'Некорректный запрос.', metadata: { raw: 'This endpoint\'s maximum context length is 163840 tokens.' } })).toBe('context_limit')
    expect(classifyAgentStopReason({ name: 'AI_InvalidPromptError', message: 'System messages are not allowed in the prompt or messages fields' })).toBe('invalid_prompt')
    expect(classifyAgentStopReason(new Error('provider unavailable'))).toBe('agent_error')
  })

  it('explains the dashboard spending limit without suggesting an immediate retry', () => {
    expect(classifyAgentStopReason({ code: 'INSUFFICIENT_BALANCE', message: 'Достигнут лимит по сумме' })).toBe('provider_spending_limit')
    expect(stopReasonMessage('provider_spending_limit')).toContain('polza.ai')
    expect(stopReasonMessage('provider_spending_limit')).toContain('лимит')
  })

  it('warns that a step-limited operation needs continuation', () => {
    expect(stopReasonMessage('step_limit')).toContain('не полностью')
    expect(stopReasonMessage('step_limit')).toContain('Продолжить')
  })
})
