import type {
  CreateLongTermFact,
  CreateWorkingEntry,
  LongTermFact,
  MemoryBudgetPatch,
  MemoryBudgets,
  MemoryChange,
  MemoryListQuery,
  MemoryPage,
  MemoryPreview,
  MemoryScope,
  MemoryStatistics,
  Project,
  UpdateLongTermFact,
  UpdateWorkingEntry,
  WorkingMemoryEntry,
} from '~/shared/memory'
import type { HistoryClearResult, MemorySource } from '~/shared/memory'

interface ProjectPage extends MemoryPage<Project> {}

export function useMemory() {
  const loadProjects = (query?: MemoryListQuery) => $fetch<ProjectPage>('/api/projects', { query })
  const listWorking = (projectId: string, query?: MemoryListQuery) => $fetch<MemoryPage<WorkingMemoryEntry>>('/api/memory/working', { query: { projectId, ...query } })
  const listLongTerm = (query?: MemoryListQuery & { projectId?: string }) => $fetch<MemoryPage<LongTermFact>>('/api/memory/long-term', { query })
  const saveWorking = (input: CreateWorkingEntry | (UpdateWorkingEntry & { id: string })) => input && 'id' in input
    ? $fetch<WorkingMemoryEntry>(`/api/memory/working/${input.id}`, { method: 'PATCH', body: input })
    : $fetch<WorkingMemoryEntry>('/api/memory/working', { method: 'POST', body: input })
  const saveLongTerm = (input: CreateLongTermFact | (UpdateLongTermFact & { id: string })) => input && 'id' in input
    ? $fetch<LongTermFact>(`/api/memory/long-term/${input.id}`, { method: 'PATCH', body: input })
    : $fetch<LongTermFact>('/api/memory/long-term', { method: 'POST', body: input })
  const deleteWorking = (id: string) => $fetch<{ deleted: boolean }>(`/api/memory/working/${id}`, { method: 'DELETE' })
  const deleteLongTerm = (id: string) => $fetch<{ deleted: boolean }>(`/api/memory/long-term/${id}`, { method: 'DELETE' })
  const loadBudgets = () => $fetch<MemoryBudgets>('/api/memory/settings')
  const updateBudgets = (patch: MemoryBudgetPatch) => $fetch<MemoryBudgets>('/api/memory/settings', { method: 'PATCH', body: patch })
  const loadPreview = (projectId?: string) => $fetch<MemoryPreview>('/api/memory/preview', { query: projectId ? { projectId } : undefined })
  const loadStatistics = (scope: MemoryScope) => $fetch<MemoryStatistics>('/api/memory/statistics', {
    query: scope.scope === 'dialogue' ? { scope: scope.scope, sessionId: scope.sessionId } : scope.scope === 'project' ? { scope: scope.scope, projectId: scope.projectId } : { scope: scope.scope },
  })
  const loadChanges = (query?: { projectId?: string; limit?: number }) => $fetch<MemoryChange[]>('/api/memory/changes', { query })
  const clearWorking = (projectId: string) => $fetch<{ deleted: number }>('/api/memory/working/clear', { method: 'POST', body: { projectId } })
  const clearLongTerm = () => $fetch<{ deleted: number }>('/api/memory/long-term/clear', { method: 'POST' })
  const detachProject = (projectId: string) => $fetch<{ detached: number }>('/api/memory/long-term/detach-project', { method: 'POST', body: { projectId } })
  const clearHistory = (sessionId: string, operationId: string) => $fetch<HistoryClearResult>(`/api/sessions/${sessionId}/history/clear`, { method: 'POST', body: { operationId } })
  const loadPendingHistoryClear = async (sessionId: string): Promise<HistoryClearResult | null> => {
    const result = await $fetch<HistoryClearResult | null>(`/api/sessions/${sessionId}/history/clear`)
    return result ?? null
  }

  return {
    loadProjects,
    listWorking,
    listLongTerm,
    saveWorking,
    saveLongTerm,
    deleteWorking,
    deleteLongTerm,
    loadBudgets,
    updateBudgets,
    loadPreview,
    loadStatistics,
    loadChanges,
    clearWorking,
    clearLongTerm,
    detachProject,
    clearHistory,
    loadPendingHistoryClear,
  }
}

export type { MemorySource }
