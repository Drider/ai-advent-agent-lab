import { routeId, taskRoute } from '../../../../tasks/api-errors'
import { createTaskService } from '../../../../tasks/commands'
import { TaskError } from '../../../../tasks/errors'
import { createTaskRepository } from '../../../../tasks/repository'

export default taskRoute((event, db) => {
  const id = routeId(event)
  return db.transaction(() => {
    const repository = createTaskRepository(db)
    if (!repository.getSession(id)) throw new TaskError('NOT_FOUND', 'Session was not found')
    const items = repository.list(id)
    const current = items.find(item => item.status === 'active' || item.status === 'paused') ?? items[0]
    return { items, current: createTaskService(db).view(current?.id ?? '', id) }
  })()
})
