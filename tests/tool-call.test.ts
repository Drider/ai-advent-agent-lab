import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { describe, expect, it } from 'vitest'
import { getToolCallStatus } from '../shared/tool-call'

const basePart = {
  type: 'tool-read_file' as const,
  toolCallId: 'read-1',
  input: { path: 'notes.md' },
}

describe('getToolCallStatus', () => {
  it.each([
    {
      part: { ...basePart, state: 'input-streaming' },
      active: true, label: 'Подготовка вызова…', loading: true,
    },
    {
      part: { ...basePart, state: 'input-available' },
      active: true, label: 'Выполняется…', loading: true,
    },
    {
      part: { ...basePart, state: 'input-available' },
      active: false, label: 'Прервано', loading: false,
    },
    {
      part: { ...basePart, state: 'output-available', output: { ok: true, text: 'Hello' } },
      active: false, label: 'Завершён', loading: false,
    },
    {
      part: { ...basePart, state: 'output-error', errorText: 'File not found' },
      active: false, label: 'Ошибка', loading: false,
    },
    {
      part: { ...basePart, state: 'output-denied', approval: { id: 'approval-1', approved: false } },
      active: false, label: 'Отклонён', loading: false,
    },
    {
      part: { ...basePart, state: 'approval-requested', approval: { id: 'approval-1' } },
      active: true, label: 'Ожидает подтверждения', loading: false,
    },
  ] as const)('shows $label for $part.state when active=$active', ({ part, active, label, loading }) => {
    expect(getToolCallStatus(part, active)).toEqual({ label, loading })
  })

  it('shows structured tool failures as errors', () => {
    const part: ToolUIPart = {
      type: 'tool-read_file',
      toolCallId: 'read-1',
      state: 'output-available',
      input: { path: 'missing.md' },
      output: { ok: false, error: { code: 'NOT_FOUND', message: 'File not found' } },
    }

    expect(getToolCallStatus(part, false)).toEqual({ label: 'Ошибка', loading: false })
  })

  it('supports completed dynamic tools with numeric results', () => {
    const part: DynamicToolUIPart = {
      type: 'dynamic-tool',
      toolName: 'rollDie',
      toolCallId: 'roll-1',
      state: 'output-available',
      input: { sides: 6 },
      output: 4,
    }

    expect(getToolCallStatus(part, true)).toEqual({ label: 'Завершён', loading: false })
  })

  it.each([true, false])('handles an approval response with approved=%s', (approved) => {
    const part: ToolUIPart = {
      type: 'tool-read_file',
      toolCallId: 'read-1',
      state: 'approval-responded',
      input: { path: 'notes.md' },
      approval: { id: 'approval-1', approved },
    }

    expect(getToolCallStatus(part, true)).toEqual(
      approved
        ? { label: 'Выполняется…', loading: true }
        : { label: 'Отклонён', loading: false },
    )
  })
})
