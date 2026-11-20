import { z } from 'zod'
import { identifier, routeId, taskBody, taskRoute } from '../../../tasks/api-errors'
import { createUserProfileRepository } from '../../../persistence/user-profile-repository'

const schema = z.strictObject({ workflowId: identifier.nullable(), expectedRevision: z.number().int().nonnegative() })
export default taskRoute(async (event, db) => {
  return createUserProfileRepository(db).setWorkflow(routeId(event), await taskBody(event, schema))
})
