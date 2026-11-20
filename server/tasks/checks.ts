import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { JsonValue, TaskArtifact, ValidationResult } from '../../shared/task'
import type { CheckDefinition } from '../../shared/workflow'
import { workingTool } from './tool-registry'
import { nonempty } from './artifacts'

const path = z.string().max(200).regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/)
  .refine(value => !value.split('.').some(key => ['__proto__', 'prototype', 'constructor'].includes(key)), 'Unsafe field path')
const field = z.strictObject({
  path, type: z.enum(['string', 'number', 'boolean', 'array', 'object']), required: z.boolean(),
  min: z.number().optional(), max: z.number().optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1).optional(),
}).refine(f => f.min === undefined || f.max === undefined || f.min <= f.max, 'Invalid field bounds')
export const checkOptions = {
  fields: z.strictObject({ fields: z.array(field) }),
  sections: z.strictObject({ headings: z.array(z.string().trim().min(1).max(200)).min(1) }),
  tool_success: z.strictObject({ toolName: z.string().min(1) }),
  file_matches: z.strictObject({ pathField: path, contentField: path }),
  numeric: z.strictObject({ datasetKey: path, recordsPath: path, valuePath: path, reportKey: path,
    metric: z.enum(['count', 'sum', 'mean']), reportedPath: path, tolerance: z.number().nonnegative() }),
}

export interface ToolReceipt { toolCallId: string; name: string; output: JsonValue; input?: JsonValue; artifactId?: string }
export interface CheckContext {
  toolResults: ToolReceipt[]
  readTextFile: (path: string) => Promise<string>
}
export function property(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key) ? value[key] : undefined
}
function lookup(value: JsonValue, path: string) {
  return path.split('.').reduce<JsonValue | undefined>(property, value)
}

// An intermediate array applies the rest of the field path to each record.
function valuesAt(value: JsonValue, segments: string[]): (JsonValue | undefined)[] {
  if (!segments.length) return [value]
  const entries = Array.isArray(value) ? value : [value]
  return entries.flatMap(entry => {
    const next = property(entry, segments[0]!)
    return next === undefined ? [undefined] : valuesAt(next, segments.slice(1))
  })
}
function matchesField(value: JsonValue | undefined, rule: z.infer<typeof field>) {
  if (value === undefined) return !rule.required
  const type = Array.isArray(value) ? 'array' : typeof value
  if (value === null || type !== rule.type || typeof value === 'number' && !Number.isFinite(value)) return false
  if (rule.required && !nonempty(value)) return false
  if (rule.enum && !rule.enum.some(option => option === value)) return false
  const size = typeof value === 'number' ? value : typeof value === 'string' || Array.isArray(value) ? value.length : undefined
  return (rule.min === undefined || size !== undefined && size >= rule.min)
    && (rule.max === undefined || size !== undefined && size <= rule.max)
}
export function successfulOutput(name: string, output: JsonValue, input?: JsonValue): boolean {
  if (property(output, 'error') !== undefined) return false
  const success = workingTool(name)?.success
  switch (success) {
    case undefined: return false
    case 'array': return Array.isArray(output)
    case 'roll': return typeof property(output, 'result') === 'number'
    case 'sessions': return Array.isArray(property(output, 'sessions'))
    case 'analysis': {
      if (!property(output, 'totals')) return false
      const ok = property(output, 'ok')
      if (ok !== undefined) return ok === true
      // Previous receipts contain errors per requested path, but no explicit success flag.
      const errors = property(output, 'fileErrors')
      if (!Array.isArray(errors)) return false
      if (!errors.length) return true
      const paths = property(input, 'paths')
      const failedPaths = new Set(errors.map(error => property(error, 'path')))
      return Array.isArray(paths) && paths.some(path => !failedPaths.has(path))
    }
    default: return property(output, success) === true
  }
}

type Outcome = Pick<ValidationResult, 'outcome' | 'details'>
function result(passed: boolean, details: JsonValue): Outcome {
  return { outcome: passed ? 'passed' : 'failed', details }
}
export async function evaluateCheck(check: CheckDefinition, inputs: TaskArtifact[], context: CheckContext): Promise<Outcome> {
  try {
    if (!inputs.length || !check.artifactKeys.every(key => inputs.some(item => item.key === key))) {
      return result(false, { reason: 'Missing input artifact' })
    }
    const content = inputs[0]!.content
    switch (check.kind) {
      case 'fields': {
        const { fields } = checkOptions.fields.parse(check.options)
        for (const input of inputs) {
          if (fields.length && (input.content === null || typeof input.content !== 'object' || Array.isArray(input.content))) {
            return result(false, { artifactKey: input.key, reason: 'Expected an object' })
          }
          if (!nonempty(input.content)) return result(false, { artifactKey: input.key, reason: 'Empty artifact' })
          for (const rule of fields) {
            const values = valuesAt(input.content, rule.path.split('.'))
            if ((!values.length && rule.required) || !values.every(value => matchesField(value, rule))) {
              return result(false, { artifactKey: input.key, field: rule.path })
            }
          }
        }
        return result(true, {})
      }
      case 'sections': {
        const { headings } = checkOptions.sections.parse(check.options)
        const markdown = typeof content === 'string' ? content : property(content, 'markdown')
        const titles = new Set<string>()
        let fence = ''
        if (typeof markdown === 'string') for (const line of markdown.split(/\r?\n/)) {
          const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
          if (marker && !fence) { fence = marker[1]!; continue }
          if (fence) {
            if (marker?.[1]?.startsWith(fence) && !marker[2]?.trim()) fence = ''
            continue
          }
          const title = /^ {0,3}#{1,6}[ \t]+(.+)$/.exec(line)?.[1]?.replace(/[ \t]+#+[ \t]*$/, '').trim()
          if (title) titles.add(title)
        }
        const missing = headings.filter(title => !titles.has(title))
        return result(!missing.length, { missing })
      }
      case 'tool_success': {
        const { toolName } = checkOptions.tool_success.parse(check.options)
        const passed = inputs.every(item => context.toolResults.some(receipt => receipt.name === toolName
          && (receipt.artifactId === undefined || receipt.artifactId === item.id) && item.sourceToolCallIds.includes(receipt.toolCallId) && successfulOutput(toolName, receipt.output, receipt.input)))
        return result(passed, { toolName })
      }
      case 'file_matches': {
        const { pathField, contentField } = checkOptions.file_matches.parse(check.options)
        const filename = lookup(content, pathField)
        const expected = lookup(content, contentField)
        if (typeof filename !== 'string' || typeof expected !== 'string') return result(false, { reason: 'Missing path or text' })
        const actual = await context.readTextFile(filename)
        const digest = (text: string) => createHash('sha256').update(text).digest('hex')
        const observedHash = digest(actual)
        return result(digest(expected) === observedHash, { observedHash })
      }
      case 'numeric': {
        const options = checkOptions.numeric.parse(check.options)
        const dataset = inputs.find(item => item.key === options.datasetKey)
        const report = inputs.find(item => item.key === options.reportKey)
        const records = dataset && lookup(dataset.content, options.recordsPath)
        const reported = report && lookup(report.content, options.reportedPath)
        if (!Array.isArray(records) || typeof reported !== 'number' || !Number.isFinite(reported)) {
          return result(false, { reason: 'Expected records and a finite reported number' })
        }
        let sum = 0
        for (const record of records) {
          const value = lookup(record, options.valuePath)
          if (typeof value !== 'number' || !Number.isFinite(value)) return result(false, { reason: 'Invalid numeric record' })
          sum += value
        }
        const expected = options.metric === 'count' ? records.length : options.metric === 'mean' ? sum / records.length : sum
        if (!Number.isFinite(expected)) return result(false, { reason: 'Metric is not finite' })
        return result(Math.abs(expected - reported) <= options.tolerance, { expected, reported })
      }
    }
  } catch {
    return { outcome: 'error', details: { reason: 'Could not evaluate check' } }
  }
}
