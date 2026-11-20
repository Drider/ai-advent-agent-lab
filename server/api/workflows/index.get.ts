import { taskRoute } from '../../tasks/api-errors'
import { createWorkflowRepository } from '../../workflows/repository'

export default taskRoute((_event, db) => ({ items: createWorkflowRepository(db).list() }))
