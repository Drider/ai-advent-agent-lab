import type Database from 'better-sqlite3'
import { tool } from 'ai'
import { z } from 'zod'
import { createTaskRepository } from '../../persistence/task-repository'
import { getTaskStage, getTemplateQuestions, normalizeTaskAnswer, TaskError } from '../../../shared/task'

const stepSchema = z.object({ step: z.string().min(1).max(500) }).strict()
const transitionSchema = z.object({
  to: z.string().min(1),
  summary: z.string().min(1).max(8_000),
  expectedRevision: z.number().int().nonnegative().safe().optional(),
}).strict()
const answerSchema = z.object({
  questionId: z.string().min(1),
  answer: z.string().min(1).max(500),
}).strict()
const amendAnswerSchema = answerSchema.extend({
  expectedRevision: z.number().int().nonnegative().safe(),
}).strict()
const taskStateSchema = z.object({}).strict()
const cancelTransitionSchema = z.object({
  pendingTransitionId: z.string().uuid(),
}).strict()

export type TaskTools = ReturnType<typeof createTaskTools>

function errorResult(error: unknown, snapshot?: ReturnType<ReturnType<typeof createTaskRepository>['getSnapshot']>) {
  if (error instanceof TaskError) {
    const current = error.snapshot ?? snapshot ?? undefined
    return {
      code: error.code,
      message: error.message,
      ...(error.allowedNext === undefined ? {} : { allowedNext: error.allowedNext }),
      ...(error.missing === undefined ? {} : { missing: error.missing }),
      ...(current === undefined ? {} : { allowedTransitions: current?.allowedTransitions ?? [], task: current }),
    }
  }
  return { code: 'UNAVAILABLE', message: 'Task operation is unavailable.' }
}

export function createTaskTools(options: {
  db?: Database.Database
  sessionId?: string
  turnId?: string
} = {}) {
  const unavailable = { code: 'UNAVAILABLE', message: 'Task storage is unavailable.' }
  const repository = () => options.db ? createTaskRepository(options.db) : undefined

  return {
    get_task_state: tool({
      description: 'Read the current persisted task snapshot. Use it after a user task action and before reporting the current stage. This tool does not mutate state and does not require an active turn.',
      inputSchema: taskStateSchema,
      execute: async () => {
        const tasks = repository()
        if (!tasks || !options.sessionId) return { ok: false as const, error: unavailable }
        return { ok: true as const, task: tasks.getSnapshot(options.sessionId) }
      },
    }),
    record_task_answer: tool({
      description: 'Save one answer to the current questionnaire question. Ask one question at a time and record every answer.',
      inputSchema: answerSchema,
      execute: async ({ questionId, answer }) => {
        const tasks = repository()
        if (!tasks || !options.sessionId || !options.turnId) return { ok: false as const, error: unavailable }
        try {
          const question = getTemplateQuestions('onboarding').find(candidate => candidate.id === questionId)
          const recordedValue = normalizeTaskAnswer(questionId, answer)
          if (question?.options && recordedValue === undefined) {
            throw new TaskError('INVALID_INPUT', `${questionId} must be one of: ${question.options.map(option => option.value).join(', ')}`)
          }
          const updated = tasks.recordAnswer(options.sessionId, { questionId, answer: recordedValue ?? answer }, { turnId: options.turnId })
          const task = tasks.getSnapshot(options.sessionId)
          const remaining = (getTaskStage(updated)?.questions ?? [])
            .filter(question => !(updated.answers[question.id] ?? '').trim())
            .map(question => question.id)
          return { ok: true as const, questionId, recordedValue: updated.answers[questionId], remaining, remainingCount: remaining.length, task }
        } catch (error) {
          return { ok: false as const, error: errorResult(error, tasks.getSnapshot(options.sessionId)) }
        }
      },
    }),
    amend_task_answer: tool({
      description: 'Correct one saved onboarding answer during the review stage without rolling back. Use the revision from get_task_state and repeat the exact saved value to the user.',
      inputSchema: amendAnswerSchema,
      execute: async ({ questionId, answer, expectedRevision }) => {
        const tasks = repository()
        if (!tasks || !options.sessionId || !options.turnId) return { ok: false as const, error: unavailable }
        try {
          const task = tasks.amendAnswer(options.sessionId, { questionId, answer, expectedRevision }, { turnId: options.turnId })
          return { ok: true as const, questionId, task }
        } catch (error) {
          return { ok: false as const, error: errorResult(error, tasks.getSnapshot(options.sessionId)) }
        }
      },
    }),
    update_task_step: tool({
      description: 'Update the concise current step of the active task. Use this while working within the current stage.',
      inputSchema: stepSchema,
      execute: async ({ step }) => {
        const tasks = repository()
        if (!tasks || !options.sessionId || !options.turnId) return { ok: false as const, error: unavailable }
        try {
          const updated = tasks.updateStep(options.sessionId, step, { turnId: options.turnId })
          const task = tasks.getSnapshot(options.sessionId)
          return { ok: true as const, step: updated.step, task }
        } catch (error) {
          return { ok: false as const, error: errorResult(error, tasks.getSnapshot(options.sessionId)) }
        }
      },
    }),
    request_task_transition: tool({
      description: 'Propose a transition to the next task stage. The user must approve it; this tool never changes the stage itself.',
      inputSchema: transitionSchema,
      execute: async ({ to, summary, expectedRevision }) => {
        const tasks = repository()
        if (!tasks || !options.sessionId || !options.turnId) return { ok: false as const, error: unavailable }
        try {
          const current = tasks.getSnapshot(options.sessionId)
          const task = tasks.requestTransition(options.sessionId, {
            to,
            summary,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          }, { turnId: options.turnId })
          const applied = task.stage === to && task.pendingTransition === null
          return {
            ok: true as const,
            from: current?.stage ?? task.stage,
            to,
            applied,
            revision: task.revision,
            pendingTransitionId: task.pendingTransition?.id ?? null,
            allowedTransitions: task.allowedTransitions,
            awaitingUserConfirmation: !applied,
            confirmationHint: applied ? null : { kind: 'button' as const, label: 'Подтвердить', command: '/task approve' as const },
            task,
          }
        } catch (error) {
          return { ok: false as const, error: errorResult(error, tasks.getSnapshot(options.sessionId)) }
        }
      },
    }),
    cancel_task_transition: tool({
      description: 'Cancel a pending task transition by its exact ID. Use only the pendingTransitionId returned by task state or request_task_transition.',
      inputSchema: cancelTransitionSchema,
      execute: async ({ pendingTransitionId }) => {
        const tasks = repository()
        if (!tasks || !options.sessionId || !options.turnId) return { ok: false as const, error: unavailable }
        try {
          const task = tasks.cancelPending(options.sessionId, pendingTransitionId, { turnId: options.turnId })
          return { ok: true as const, pendingTransitionId, task }
        } catch (error) {
          return { ok: false as const, error: errorResult(error, tasks.getSnapshot(options.sessionId)) }
        }
      },
    }),
  }
}
