import { z } from 'zod'
import { getQuery } from 'h3'
import { commandResponse, identifier, operationFields, routeId, taskBody, taskRoute } from '../../../tasks/api-errors'
import { parseTaskCommand } from '../../../tasks/command-parser'
import { createTaskService } from '../../../tasks/commands'
import { TaskError } from '../../../tasks/errors'

const schema = z.strictObject({ ...operationFields, text: z.string().max(2000) })
const query = z.strictObject({ expectedTaskId: identifier.optional() })
export default taskRoute(async (event, db) => {
  const parsed = query.safeParse(getQuery(event))
  if (!parsed.success) throw new TaskError('INVALID_INPUT', 'Invalid expected task ID')
  const { expectedTaskId } = parsed.data
  const { text, ...operation } = await taskBody(event, schema)
  const command = parseTaskCommand(text)
  if (!command) throw new TaskError('INVALID_INPUT', 'Expected one complete task command')
  return commandResponse(await createTaskService(db).applyToCurrent(routeId(event), { ...operation, command },
    expectedTaskId === 'none' ? null : expectedTaskId))
})
