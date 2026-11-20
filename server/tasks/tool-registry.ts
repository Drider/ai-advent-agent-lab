import type { FileTools } from '../tools/files'
import type { ModelConfigurationTools } from '../tools/model-configurations'
import type { SessionTools } from '../tools/sessions'
import type { UserProfileTools } from '../tools/user-profiles'

type WorkingToolName = 'rollDie' | 'listSavedRolls' | 'save_memory'
  | keyof (FileTools & ModelConfigurationTools & SessionTools & UserProfileTools)

const registry = {
  rollDie: { mutating: true, success: 'roll' },
  listSavedRolls: { mutating: false, success: 'array' },
  save_memory: { mutating: true, success: 'saved' },
  find_files: { mutating: false, success: 'ok' },
  read_file: { mutating: false, success: 'ok' },
  read_pdf: { mutating: false, success: 'ok' },
  search_text: { mutating: false, success: 'ok' },
  text_stats: { mutating: false, success: 'ok' },
  write_file: { mutating: true, success: 'ok' },
  get_current_session: { mutating: false, success: 'ok' },
  list_sessions: { mutating: false, success: 'sessions' },
  read_session_file: { mutating: false, success: 'ok' },
  analyze_sessions: { mutating: false, success: 'analysis' },
  save_model_configuration: { mutating: true, success: 'saved' },
  list_model_configurations: { mutating: false, success: 'ok' },
  delete_model_configuration: { mutating: true, success: 'deleted' },
  list_user_profiles: { mutating: false, success: 'ok' },
  get_user_profile: { mutating: false, success: 'ok' },
  create_user_profile: { mutating: true, success: 'created' },
  update_user_profile: { mutating: true, success: 'updated' },
  select_user_profile: { mutating: true, success: 'selected' },
} satisfies Record<WorkingToolName, { mutating: boolean; success: string }>

export function workingTool(name: string) {
  return Object.hasOwn(registry, name) ? registry[name as WorkingToolName] : undefined
}
