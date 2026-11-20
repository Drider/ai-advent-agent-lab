import type { TaskErrorCode } from '../../shared/task'

export interface WorkflowSchemaIssue {
  path: string
  message: string
}

export class TaskError extends Error {
  constructor(
    public readonly code: TaskErrorCode,
    message: string,
    public readonly issues: WorkflowSchemaIssue[] = [],
  ) {
    super(message)
    this.name = 'TaskError'
  }
}

export class WorkflowSchemaError extends TaskError {
  constructor(issues: WorkflowSchemaIssue[]) {
    super('INVALID_INPUT', 'Workflow definition is invalid', issues)
    this.name = 'WorkflowSchemaError'
  }
}
