import type { TaskCommand } from './task'

export function parseTaskCommand(text: string): TaskCommand | null {
  const input = text.trim()
  switch (input) {
    case '/task pause': return { type: 'pause' }
    case '/task resume': return { type: 'resume' }
    case '/task cancel': return { type: 'cancel' }
    case '/task complete': return { type: 'complete_basic' }
  }
  const approval = /^\/task approve ([\w-]{1,200})$/.exec(input)
  if (approval) return { type: 'approve', approvalId: approval[1]! }
  const attach = /^\/task attach ([\w-]{1,200}) ([1-9]\d*)$/.exec(input)
  if (attach && Number.isSafeInteger(Number(attach[2]))) {
    return { type: 'attach', workflowId: attach[1]!, version: Number(attach[2]) }
  }
  return null
}
