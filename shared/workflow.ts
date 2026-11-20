import type { JsonValue } from './task'

export interface ExpectedAction {
  actor: 'agent' | 'user' | 'system'
  kind: 'input' | 'artifact' | 'approval' | 'validation' | 'result'
  label: string
  artifactKey?: string
}

export interface WorkflowDefinition {
  schemaVersion: 1
  entryNodeId: string
  resultArtifactKey: string
  artifactSlots: ArtifactSlot[]
  nodes: WorkflowNode[]
  transitions: WorkflowTransition[]
  checks: CheckDefinition[]
  completionCheckIds: string[]
  contextExports: string[]
}

export interface ArtifactSlot {
  key: string
  type: 'plan' | 'answers' | 'dataset' | 'implementation' | 'report' | 'result' | 'note'
}

export interface WorkflowNode {
  id: string
  kind: 'work' | 'approval' | 'validation' | 'success'
  stage: string
  label: string
  expected: ExpectedAction
  allowedTools: string[]
  writableArtifacts: string[]
  requiredApprovalKeys: string[]
  checkIds: string[]
}

export interface WorkflowTransition {
  id: string
  from: string
  to: string
  actor: 'agent' | 'user' | 'system'
  event: 'advance' | 'approve' | 'checks_passed' | 'checks_failed'
  guards: Guard[]
  invalidateApprovalKeys: string[]
}

export type Guard =
  | { kind: 'artifact_present'; artifactKey: string }
  | { kind: 'approval_current'; artifactKey: string }
  | { kind: 'checks_current'; checkIds: string[] }
  | { kind: 'checks_failed_current'; checkIds: string[] }

export interface CheckDefinition {
  id: string
  kind: 'fields' | 'sections' | 'tool_success' | 'file_matches' | 'numeric'
  artifactKeys: string[]
  options: JsonValue
}

export interface WorkflowVersion {
  workflowId: string
  version: number
  definition: WorkflowDefinition
  hash: string
  createdAt: string
}

export interface WorkflowSummary {
  id: string
  name: string
  latestVersion: number
}
