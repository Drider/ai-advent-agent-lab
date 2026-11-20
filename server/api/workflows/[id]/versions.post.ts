import { z } from 'zod'
import { sourceFields, routeId, taskBody, taskRoute } from '../../../tasks/api-errors'
import { parseWorkflowSource } from '../../../workflows/parse'
import { createWorkflowRepository } from '../../../workflows/repository'

const schema = z.strictObject({ expectedVersion: z.number().int().positive(), ...sourceFields })
export default taskRoute(async (event, db) => {
  const { expectedVersion, source, format } = await taskBody(event, schema)
  return createWorkflowRepository(db).publish(routeId(event), expectedVersion, parseWorkflowSource(source, format))
})
