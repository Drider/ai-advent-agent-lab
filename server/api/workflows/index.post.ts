import { z } from 'zod'
import { sourceFields, taskBody, taskRoute } from '../../tasks/api-errors'
import { parseWorkflowSource } from '../../workflows/parse'
import { createWorkflowRepository } from '../../workflows/repository'

const schema = z.strictObject({ name: z.string().trim().min(1).max(200), ...sourceFields })
export default taskRoute(async (event, db) => {
  const { name, source, format } = await taskBody(event, schema)
  return createWorkflowRepository(db).create(name, parseWorkflowSource(source, format))
})
