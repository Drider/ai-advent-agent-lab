import { dialogueId, routeId, taskRoute } from '../../../../tasks/api-errors'
import { createArtifactStore } from '../../../../tasks/artifacts'
import { TaskError } from '../../../../tasks/errors'

export default taskRoute((event, db) => {
  const artifact = createArtifactStore(db).byId(routeId(event), routeId(event, 'artifactId'), dialogueId(event))
  if (!artifact) throw new TaskError('NOT_FOUND', 'Task artifact was not found')
  return artifact
})
