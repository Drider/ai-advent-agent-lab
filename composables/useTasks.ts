import { onScopeDispose, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { ofetch } from 'ofetch'
import type { TaskArtifact, TaskCommand, TaskCommandResult, TaskSnapshot, TaskView, TaskWorkflowSelection } from '../shared/task'
import { parseTaskCommand } from '~/shared/task-command-parser'
import { taskRequest, type TaskUiIntent } from '~/shared/task-ui'

type Fetcher = <T>(url: string, options?: { method?: 'POST'; query?: Record<string, string | undefined>; body?: object }) => Promise<T>
type Pending = { request: ReturnType<typeof taskRequest>; intent: TaskUiIntent }

export function useTasks(sessionId: MaybeRefOrGetter<string>, fetcher: Fetcher = ofetch) {
  const view = shallowRef<TaskView | null>(null)
  const history = shallowRef<TaskSnapshot[]>([])
  const loading = shallowRef(false)
  const busy = shallowRef(false)
  const error = shallowRef<string | null>(null)
  const pending = shallowRef<Pending | null>(null)
  let generation = 0
  let readSequence = 0
  function reset() {
    generation++
    view.value = null
    history.value = []
    pending.value = null
    error.value = null
    busy.value = loading.value = false
  }
  watch(() => toValue(sessionId), reset, { flush: 'sync' })
  onScopeDispose(reset)
  async function readView() {
    const epoch = generation
    const sequence = ++readSequence
    const isCurrent = () => epoch === generation && sequence === readSequence
    loading.value = true
    try {
      const data = await fetcher<{ current: TaskView; items: TaskSnapshot[] }>('/api/sessions/' + encodeURIComponent(toValue(sessionId)) + '/tasks')
      if (isCurrent()) {
        view.value = data.current
        history.value = data.items
      }
      return isCurrent()
    } catch (e) {
      if (isCurrent()) error.value = e instanceof Error ? e.message : 'Не удалось загрузить задачу.'
      return false
    } finally {
      if (isCurrent()) loading.value = false
    }
  }
  async function refresh() { await readView() }
  async function execute(entry: Pending): Promise<TaskCommandResult> {
    if (busy.value) throw new Error('Действие ещё выполняется.')
    busy.value = true
    const epoch = generation
    const { url, query, body } = entry.request
    error.value = null
    try {
      const result = await fetcher<TaskCommandResult>(url, { method: 'POST', query, body })
      if (epoch !== generation) throw new Error('Диалог изменился.')
      if (!await readView()) throw new Error('Не удалось подтвердить текущее состояние. Повторите действие.')
      if (epoch !== generation) throw new Error('Диалог изменился.')
      pending.value = null
      return result
    } catch (e) {
      if (epoch !== generation) throw e
      const http = e as { statusCode?: number; data?: { data?: TaskCommandResult; statusMessage?: string } }
      const rejection = http.data?.data
      if (http.statusCode && http.statusCode < 500) {
        pending.value = null
        await refresh()
        if (epoch !== generation) throw e
      } else pending.value = entry
      error.value = rejection?.ok === false ? rejection.error.message : http.data?.statusMessage ?? (e instanceof Error ? e.message : 'Не удалось выполнить действие.')
      if (rejection?.ok === false) return rejection
      throw e
    } finally {
      if (epoch === generation) busy.value = false
    }
  }
  function mutate(intent: TaskUiIntent) {
    if (pending.value) {
      if (JSON.stringify(intent) === JSON.stringify(pending.value.intent)) return execute(pending.value)
      throw new Error('Сначала повторите предыдущее действие.')
    }
    if (!view.value) throw new Error('Дождитесь загрузки задачи.')
    const request = taskRequest(toValue(sessionId), view.value, intent, crypto.randomUUID())
    return execute({ intent, request })
  }
  async function submitCommand(text: string) {
    if (!parseTaskCommand(text)) return { handled: false }
    return { handled: true, result: await mutate({ kind: 'command', text: text.trim() }) }
  }
  function retry() {
    if (!pending.value) throw new Error('Нет действия для повтора.')
    return execute(pending.value)
  }
  function artifact(taskId: string, artifactId: string) {
    return fetcher<TaskArtifact>('/api/tasks/' + encodeURIComponent(taskId) + '/artifacts/' + encodeURIComponent(artifactId), { query: { sessionId: toValue(sessionId) } })
  }
  return { view, history, loading, busy, error, pending, refresh, retry, submitCommand, artifact,
    act: (command: TaskCommand) => mutate({ kind: 'action', command }),
    create: (task: string, selection: TaskWorkflowSelection) => mutate({ kind: 'create', task, selection }) }
}
