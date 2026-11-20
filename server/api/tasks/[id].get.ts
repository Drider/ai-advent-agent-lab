import { dialogueId, routeId, taskRoute } from '../../tasks/api-errors'
import { createTaskService } from '../../tasks/commands'
import { TaskError } from '../../tasks/errors'

export default taskRoute((event, db) => db.transaction(() => {
  const view = createTaskService(db).view(routeId(event), dialogueId(event))
  if (!view.task) throw new TaskError('NOT_FOUND', 'Task was not found')
  return view
})())
