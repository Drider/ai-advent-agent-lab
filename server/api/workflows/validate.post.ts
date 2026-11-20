import { z } from 'zod'
import { sourceFields, taskBody, taskRoute } from '../../tasks/api-errors'
import { parseWorkflowSource } from '../../workflows/parse'
import { workflowHash } from '../../workflows/schema'

const schema = z.strictObject(sourceFields)
export default taskRoute(async event => {
  const { source, format } = await taskBody(event, schema)
  const definition = parseWorkflowSource(source, format)
  return { valid: true, definition, hash: workflowHash(definition) }
})
