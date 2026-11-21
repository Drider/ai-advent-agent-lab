import { shallowRef } from 'vue'
import type { WorkflowSummary, WorkflowVersion } from '../shared/workflow'

export type SourceFormat = 'json' | 'yaml'
type WorkflowSource = { source: string; format: SourceFormat }
type Publication = WorkflowSource & ({ name: string } | { id: string; expectedVersion: number })

export function useWorkflows() {
  const items = shallowRef<WorkflowSummary[]>([])
  const error = shallowRef('')
  async function load() {
    try {
      items.value = (await $fetch<{ items: WorkflowSummary[] }>('/api/workflows')).items
      error.value = ''
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось загрузить процессы.'
    }
  }
  const read = (id: string, version?: number) => $fetch<{ workflow: WorkflowSummary; version: WorkflowVersion }>('/api/workflows/' + encodeURIComponent(id), { query: { version } })
  const validate = (source: string, format: SourceFormat) => $fetch('/api/workflows/validate', { method: 'POST', body: { source, format } })
  async function publish(input: Publication) {
    if ('id' in input) {
      const { id, ...body } = input
      return $fetch<WorkflowVersion>('/api/workflows/' + encodeURIComponent(id) + '/versions', { method: 'POST', body })
    }
    return $fetch<WorkflowVersion>('/api/workflows', { method: 'POST', body: input })
  }
  return { items, error, load, read, validate, publish }
}
