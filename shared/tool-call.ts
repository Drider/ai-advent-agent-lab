import type { DynamicToolUIPart, ToolUIPart } from 'ai'

export type ChatToolPart = ToolUIPart | DynamicToolUIPart

export function getToolCallStatus(part: ChatToolPart, isActive: boolean): {
  label: string
  loading: boolean
} {
  if (part.state === 'output-available') {
    const failed = typeof part.output === 'object'
      && part.output !== null
      && 'ok' in part.output
      && part.output.ok === false

    return { label: failed ? 'Ошибка' : 'Завершён', loading: false }
  }

  if (part.state === 'output-error') {
    return { label: 'Ошибка', loading: false }
  }

  if (part.state === 'output-denied'
    || (part.state === 'approval-responded' && !part.approval.approved)) {
    return { label: 'Отклонён', loading: false }
  }

  if (part.state === 'approval-requested') {
    return { label: 'Ожидает подтверждения', loading: false }
  }

  if (!isActive) {
    return { label: 'Прервано', loading: false }
  }

  return {
    label: part.state === 'input-streaming' ? 'Подготовка вызова…' : 'Выполняется…',
    loading: true,
  }
}
