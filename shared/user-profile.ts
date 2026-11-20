export interface UserProfileSummary {
  id: string
  name: string
  revision: number
  defaultWorkflowId: string | null
  createdAt: string
  updatedAt: string
}

export interface UserProfile extends UserProfileSummary {
  instructions: string
}

export interface UserProfileSnapshot {
  id: string
  name: string
  revision: number
  defaultWorkflowId: string | null
  instructions: string
}

export interface CreateUserProfileInput {
  name: string
  instructions: string
}

export interface UpdateUserProfileInput {
  name?: string
  instructions?: string
  expectedRevision: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false
      index += 1
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false
    }
  }
  return true
}

function validateName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('profile name must be a string')
  const name = value.trim()
  if (name.length < 1 || name.length > 80) throw new Error('profile name must be 1 to 80 characters')
  if (!isWellFormedUnicode(name) || name.includes('\0')) throw new Error('profile name must contain valid Unicode text')
  return name
}

function validateInstructions(value: unknown): string {
  if (typeof value !== 'string') throw new Error('profile instructions must be a string')
  if (value.length > 16_000) throw new Error('profile instructions must be at most 16000 UTF-16 code units')
  if (!isWellFormedUnicode(value) || value.includes('\0')) throw new Error('profile instructions must contain valid Unicode text')
  return value
}

export function userProfileNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().trim()
}

export function validateUserProfileCreate(input: unknown): CreateUserProfileInput {
  if (!isRecord(input) || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'name') || !Object.hasOwn(input, 'instructions')) {
    throw new Error('profile must contain only name and instructions')
  }
  return { name: validateName(input.name), instructions: validateInstructions(input.instructions) }
}

export function validateUserProfileUpdate(input: unknown): UpdateUserProfileInput {
  if (!isRecord(input)
    || !Object.hasOwn(input, 'expectedRevision')
    || Object.keys(input).some(key => !['name', 'instructions', 'expectedRevision'].includes(key))) {
    throw new Error('profile update must contain expectedRevision and optional name or instructions')
  }
  const expectedRevision = input.expectedRevision
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative safe integer')
  }
  if (!Object.hasOwn(input, 'name') && !Object.hasOwn(input, 'instructions')) {
    throw new Error('profile update must change name or instructions')
  }
  return {
    ...(Object.hasOwn(input, 'name') ? { name: validateName(input.name) } : {}),
    ...(Object.hasOwn(input, 'instructions') ? { instructions: validateInstructions(input.instructions) } : {}),
    expectedRevision,
  }
}
