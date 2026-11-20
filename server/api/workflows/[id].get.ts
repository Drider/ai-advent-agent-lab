import { getQuery } from 'h3'
import { z } from 'zod'
import { taskRoute, routeId } from '../../tasks/api-errors'
import { TaskError } from '../../tasks/errors'
import { createWorkflowRepository } from '../../workflows/repository'

const query = z.strictObject({ version: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive()).optional() })
export default taskRoute((event, db) => {
  const id = routeId(event)
  const parsed = query.safeParse(getQuery(event))
  if (!parsed.success) throw new TaskError('INVALID_INPUT', 'Expected a positive workflow version')
  const workflows = createWorkflowRepository(db)
  return db.transaction(() => {
    const version = workflows.get(id, parsed.data.version)
    if (!version) throw new TaskError('NOT_FOUND', 'Workflow version was not found')
    return { workflow: workflows.list().find(item => item.id === id)!, version }
  })()
})
