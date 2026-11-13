import type { UIMessage } from 'ai'

export function estimateInputTokens(messages: UIMessage[], promptOverheadTokens: number): number {
  const bytes = messages.reduce((total, message) => total + Buffer.byteLength(JSON.stringify({
    role: message.role,
    parts: message.parts,
  }), 'utf8'), 0)
  return Math.ceil(bytes / 2) + promptOverheadTokens
}

export function estimateMessageCharacters(messages: UIMessage[]): number {
  return messages.reduce((total, message) => total + JSON.stringify({ role: message.role, parts: message.parts }).length, 0)
}
