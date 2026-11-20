import { z } from 'zod'
import { commandResponse, dialogueId, identifier, operationFields, routeId, taskBody, taskRoute, versionFields } from '../../../tasks/api-errors'
import { createTaskService } from '../../../tasks/commands'

const command = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('attach'), ...versionFields }),
  z.strictObject({ type: z.literal('pause') }), z.strictObject({ type: z.literal('resume') }),
  z.strictObject({ type: z.literal('cancel') }), z.strictObject({ type: z.literal('complete_basic') }),
  z.strictObject({ type: z.literal('approve'), approvalId: identifier }),
  z.strictObject({ type: z.literal('resolve_recovery'), operationId: identifier, outcome: z.enum(['completed', 'failed']) }),
])
const schema = z.strictObject({ ...operationFields, command })

export default taskRoute(async (event, db) => {
  const envelope = await taskBody(event, schema)
  return commandResponse(await createTaskService(db).apply(routeId(event), envelope, { role: 'user', sessionId: dialogueId(event) }))
})
