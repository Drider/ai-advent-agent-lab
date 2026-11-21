import { describe, expect, it } from 'vitest'
import {
  TASK_TEMPLATES,
  TaskError,
  assertTransition,
  getExpectedAction,
  getTaskActiveTools,
  getTemplateQuestions,
  isTaskOpen,
  parseTaskCommand,
  taskBlocksWrites,
  type TaskState,
} from '../shared/task'

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'task-1',
    sessionId: 'session-1',
    templateId: 'dev',
    goal: 'Сделать задачу',
    stage: 'planning',
    step: '',
    status: 'active',
    artifacts: {},
    answers: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('task templates and transitions', () => {
  it('defines both templates and their initial and terminal stages', () => {
    expect(TASK_TEMPLATES.map(template => template.id)).toEqual(['dev', 'bugfix', 'onboarding'])
    expect(TASK_TEMPLATES[0]?.stages[0]?.id).toBe('planning')
    expect(TASK_TEMPLATES[0]?.stages.at(-1)?.next).toEqual([])
    expect(TASK_TEMPLATES[1]?.stages.map(stage => stage.id)).toEqual([
      'diagnosis', 'planning', 'execution', 'validation', 'done',
    ])
  })

  it('defines the onboarding template with five interview questions', () => {
    expect(getTemplateQuestions('onboarding').map(question => question.id)).toEqual(['name', 'role', 'goal', 'level', 'style'])
    expect(getTemplateQuestions('onboarding').find(question => question.id === 'level')?.options).toEqual([
      { value: 'beginner', label: 'Новичок' },
      { value: 'intermediate', label: 'Средний' },
      { value: 'expert', label: 'Эксперт' },
    ])
    expect(getTemplateQuestions('onboarding').find(question => question.id === 'style')?.options).toEqual([
      { value: 'brief', label: 'Кратко' },
      { value: 'detailed', label: 'Подробно' },
    ])
    expect(getTemplateQuestions('dev')).toEqual([])
  })

  it('rejects leaving the interview until every question is answered', () => {
    const partial = task({ templateId: 'onboarding', stage: 'interview', answers: { name: 'Игорь', role: '  ' } })
    expect(() => assertTransition(partial, 'review', 'Ответы')).toThrow(expect.objectContaining({
      code: 'ANSWERS_MISSING',
      missing: ['role', 'goal', 'level', 'style'],
    }))
    const full = task({
      templateId: 'onboarding',
      stage: 'interview',
      answers: { name: 'Игорь', role: 'Разработчик', goal: 'Учёба', level: 'средний', style: 'кратко' },
    })
    expect(() => assertTransition(full, 'review', 'Ответы')).not.toThrow()
  })

  it('checks the graph before answers and needs no answers outside the interview', () => {
    expect(() => assertTransition(task({ templateId: 'onboarding', stage: 'interview' }), 'done', 'x'))
      .toThrow(expect.objectContaining({ code: 'TRANSITION_NOT_ALLOWED' }))
    expect(() => assertTransition(task({ templateId: 'onboarding', stage: 'review' }), 'interview', 'Исправить')).not.toThrow()
  })

  it('allows only the transitions declared by the current stage', () => {
    expect(() => assertTransition(task(), 'execution', 'План готов')).not.toThrow()
    expect(() => assertTransition(task({ templateId: 'bugfix', stage: 'diagnosis' }), 'planning', 'Причина найдена')).not.toThrow()
    expect(() => assertTransition(task({ templateId: 'bugfix', stage: 'planning' }), 'execution', 'План исправления готов')).not.toThrow()
    expect(() => assertTransition(task({ stage: 'execution' }), 'validation', 'Реализация готова')).not.toThrow()
    expect(() => assertTransition(task({ stage: 'validation' }), 'execution', 'Нужна доработка')).not.toThrow()
    expect(() => assertTransition(task({ stage: 'validation' }), 'done', 'Проверка пройдена')).not.toThrow()
  })

  it.each(['validation', 'done'])(
    'rejects planning to %s',
    to => {
      expect(() => assertTransition(task(), to, 'Попытка')).toThrowError(TaskError)
      try {
        assertTransition(task(), to, 'Попытка')
      } catch (error) {
        expect(error).toMatchObject({ code: 'TRANSITION_NOT_ALLOWED', allowedNext: ['execution'] })
      }
    },
  )

  it('rejects execution directly to done', () => {
    expect(() => assertTransition(task({ stage: 'execution' }), 'done', 'Попытка')).toThrowError(
      expect.objectContaining({ code: 'TRANSITION_NOT_ALLOWED', allowedNext: ['validation'] }),
    )
  })

  it('rejects transitions while paused, pending, finished, or without a summary', () => {
    expect(() => assertTransition(task({ status: 'paused' }), 'execution', 'План')).toThrowError(
      expect.objectContaining({ code: 'TASK_PAUSED' }),
    )
    expect(() => assertTransition(task({ pendingStage: 'execution', pendingSummary: 'План' }), 'execution', 'План')).toThrowError(
      expect.objectContaining({ code: 'TRANSITION_PENDING' }),
    )
    expect(() => assertTransition(task({ status: 'done', stage: 'done' }), 'done', 'Финал')).toThrowError(
      expect.objectContaining({ code: 'TASK_FINISHED' }),
    )
    expect(() => assertTransition(task(), 'execution', '  ')).toThrowError(
      expect.objectContaining({ code: 'SUMMARY_REQUIRED' }),
    )
  })
})

describe('task expected actions and write access', () => {
  it('recognizes only active and paused tasks as open', () => {
    expect(isTaskOpen(task())).toBe(true)
    expect(isTaskOpen(task({ status: 'paused' }))).toBe(true)
    expect(isTaskOpen(task({ status: 'done' }))).toBe(false)
    expect(isTaskOpen(task({ status: 'cancelled' }))).toBe(false)
  })

  it('computes expected actions from the current state', () => {
    expect(getExpectedAction(task())).toContain('Составить план')
    expect(getExpectedAction(task({ status: 'paused' }))).toBe('/task resume')
    expect(getExpectedAction(task({ pendingStage: 'execution', pendingSummary: 'План' }))).toBe('/task approve | /task reject')
    expect(getExpectedAction(task({ stage: 'done', status: 'done' }))).toBe('')
  })

  it('blocks writes until execution is active', () => {
    expect(taskBlocksWrites(task())).toBe(true)
    expect(taskBlocksWrites(task({ stage: 'execution' }))).toBe(false)
    expect(taskBlocksWrites(task({ stage: 'execution', status: 'paused' }))).toBe(true)
    expect(taskBlocksWrites(task({ stage: 'done', status: 'done' }))).toBe(false)
  })

  it('limits agent tools by stage and keeps questionnaire tools available on pause', () => {
    const names = [
      'rollDie', 'read_file', 'write_file', 'get_task_state', 'cancel_task_transition',
      'record_task_answer', 'amend_task_answer', 'update_task_step', 'request_task_transition',
    ]
    expect(getTaskActiveTools(task({ templateId: 'onboarding', stage: 'interview' }), names))
      .toEqual(['get_task_state', 'cancel_task_transition', 'record_task_answer', 'update_task_step', 'request_task_transition'])
    expect(getTaskActiveTools(task({ templateId: 'onboarding', stage: 'interview', status: 'paused' }), names))
      .toEqual(['get_task_state', 'cancel_task_transition', 'record_task_answer', 'update_task_step', 'request_task_transition'])
    expect(getTaskActiveTools(task({ templateId: 'onboarding', stage: 'review' }), names))
      .toEqual(['get_task_state', 'cancel_task_transition', 'amend_task_answer', 'update_task_step', 'request_task_transition'])
    expect(getTaskActiveTools(task({ status: 'paused' }), names)).toContain('get_task_state')
    expect(getTaskActiveTools(task({ pendingStage: 'execution', pendingSummary: 'План' }), names)).toContain('get_task_state')
    expect(getTaskActiveTools(task({ templateId: 'onboarding', stage: 'done', status: 'done' }), names)).toBeUndefined()
  })
})

describe('task command parsing', () => {
  it('parses start, lifecycle actions, and rejects unknown commands', () => {
    expect(parseTaskCommand('/task start dev Сделать отчёт')).toEqual({
      ok: true, action: 'start', templateId: 'dev', goal: 'Сделать отчёт',
    })
    expect(parseTaskCommand('/task start onboarding Знакомство')).toEqual({
      ok: true, action: 'start', templateId: 'onboarding', goal: 'Знакомство',
    })
    expect(parseTaskCommand('/task approve')).toEqual({ ok: true, action: 'approve' })
    expect(parseTaskCommand('/task pause')).toEqual({ ok: true, action: 'pause' })
    expect(parseTaskCommand('/task cancel')).toEqual({ ok: true, action: 'cancel' })
    expect(parseTaskCommand('/task wat')).toMatchObject({ ok: false })
    expect(parseTaskCommand('обычное сообщение')).toEqual({ ok: false, error: expect.any(String) })
  })

  it('does not recognize /tasks as a task command', () => {
    expect(parseTaskCommand('/tasks')).toEqual({ ok: false, error: 'Команда должна начинаться с /task.' })
  })

  it('preserves line breaks in a multiline task goal', () => {
    expect(parseTaskCommand('/task start dev Первая строка\nВторая строка')).toEqual({
      ok: true,
      action: 'start',
      templateId: 'dev',
      goal: 'Первая строка\nВторая строка',
    })
  })
})
