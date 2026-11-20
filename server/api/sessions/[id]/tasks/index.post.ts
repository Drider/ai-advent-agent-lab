import { z } from 'zod'
import { commandResponse, identifier, routeId, taskBody, taskRoute, versionFields } from '../../../../tasks/api-errors'
import { createTaskService } from '../../../../tasks/commands'

const schema = z.strictObject({ operationId: identifier, task: z.string().max(500),
  selection: z.union([z.enum(['profile_default', 'none']), z.strictObject(versionFields)]) })

export default taskRoute(async (event, db) => {
  const input = await taskBody(event, schema)
  const sessionId = routeId(event)
  return commandResponse(createTaskService(db).create({ ...input, sessionId }, { role: 'user', sessionId }))
})
