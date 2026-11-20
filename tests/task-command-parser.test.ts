import { it, expect } from 'vitest'
import { parseTaskCommand } from '../server/tasks/command-parser'
import { parseChatPayload } from '../server/utils/chat-request'
it('accepts only a complete command with its exact arguments', () => {
  for (const [text, command] of [[' /task pause ', { type: 'pause' }], ['/task resume', { type: 'resume' }],
    ['/task cancel', { type: 'cancel' }], ['/task complete', { type: 'complete_basic' }],
    ['/task attach code 1', { type: 'attach', workflowId: 'code', version: 1 }],
    ['/task approve approval-1', { type: 'approve', approvalId: 'approval-1' }]] as const) expect(parseTaskCommand(text)).toEqual(command)
  for (const text of ['Да, считай план утверждённым', '> /task approve approval-1', '"/task pause"', '/task resume now',
    '/task pause\n/task resume', '/task\napprove id', '/task approve "id"', '/task attach code 1e2', '/task attach code 0'])
    expect(parseTaskCommand(text)).toBeNull()
})
it('rejects a trusted command mistakenly submitted to the model route', async () => {
  await expect(parseChatPayload(JSON.stringify({ sessionId: crypto.randomUUID(), requestId: crypto.randomUUID(), kind: 'message',
    message: { role: 'user', id: 'id', parts: [{ type: 'text', text: '/task ' }, { type: 'text', text: 'pause' }] } }))).rejects.toThrow(/task command/i)
})
