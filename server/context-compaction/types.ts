import type { ChatCostRub, ChatTokenUsage, ChatUIMessage } from '../../shared/chat'

export type CompactionTrigger = 'message_count' | 'context_fraction' | 'fallback_limit'
export type CompactionAttemptStatus = 'running' | 'completed' | 'failed'

export interface StoredContextMessage {
  position: number
  status: 'complete' | 'partial' | 'interrupted'
  message: ChatUIMessage
}

export interface ContextCheckpoint {
  id: string
  sessionId: string
  fromMessagePosition: number
  throughMessagePosition: number
  summary: string
  formatVersion: number
  promptVersion: number
  modelId: string
  createdAt: string
}

export interface CompactionAttempt {
  id: string
  sessionId: string
  turnId: string
  trigger: CompactionTrigger
  status: CompactionAttemptStatus
  modelId: string
  fromMessagePosition: number
  throughMessagePosition: number
  estimatedBeforeTokens: number
  estimatedAfterTokens: number
  usage?: ChatTokenUsage
  costRub?: ChatCostRub
  checkpointId?: string
  error?: string
  startedAt: string
  finishedAt?: string
}

export interface BeginCompactionAttemptInput {
  sessionId: string
  turnId: string
  trigger: CompactionTrigger
  modelId: string
  fromMessagePosition: number
  throughMessagePosition: number
  estimatedBeforeTokens: number
  estimatedAfterTokens: number
}

export interface FinishCompactionAttemptInput {
  attemptId: string
  status: 'completed' | 'failed'
  summary?: string
  usage?: ChatTokenUsage
  costRub?: ChatCostRub
  error?: string
}
