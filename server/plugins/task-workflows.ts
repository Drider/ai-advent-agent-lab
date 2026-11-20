import { defineNitroPlugin } from 'nitropack/runtime'
import { getChatDatabase } from '../persistence/db'
import { seedBuiltInWorkflows } from '../workflows/templates'

export default defineNitroPlugin(() => {
  seedBuiltInWorkflows(getChatDatabase())
})
