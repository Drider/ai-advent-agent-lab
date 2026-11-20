import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml'
import type { WorkflowDefinition } from '../../shared/workflow'
import { WorkflowSchemaError } from '../tasks/errors'
import {
  assertWorkflowSize,
  MAX_WORKFLOW_DEPTH,
  workflowFieldPath,
  validateWorkflowDefinition,
} from './schema'

function checkDocumentNode(node: unknown, path: (string | number)[] = []): void {
  if (!isNode(node)) return

  function reject(message: string): never {
    throw new WorkflowSchemaError([{ path: workflowFieldPath(path), message }])
  }

  if (isAlias(node)) reject('Aliases are forbidden')
  if ('anchor' in node && node.anchor !== undefined) reject('Anchors are forbidden')
  if (node.tag !== undefined) reject('Explicit tags are forbidden')
  if ((isMap(node) || isSeq(node)) && path.length >= MAX_WORKFLOW_DEPTH) {
    reject(`Workflow must have at most ${MAX_WORKFLOW_DEPTH} levels of nesting`)
  }

  if (isMap(node)) {
    const keys = new Set<string>()
    for (const { key, value } of node.items) {
      if (!isScalar(key) || typeof key.value !== 'string') {
        reject('Mapping keys must be strings')
      }

      const field = [...path, key.value]
      checkDocumentNode(key, field)
      if (keys.has(key.value)) {
        throw new WorkflowSchemaError([{ path: workflowFieldPath(field), message: 'Mapping keys must be unique' }])
      }
      keys.add(key.value)
      checkDocumentNode(value, field)
    }
  } else if (isSeq(node)) {
    node.items.forEach((value, index) => checkDocumentNode(value, [...path, index]))
  }
}

export function parseWorkflowSource(source: string, format: 'json' | 'yaml'): WorkflowDefinition {
  assertWorkflowSize(source)

  let json: unknown
  if (format === 'json') {
    try {
      json = JSON.parse(source)
    } catch {
      throw new WorkflowSchemaError([{ path: '$', message: 'Workflow source must be valid JSON' }])
    }
  }

  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
    version: '1.2',
    schema: 'core',
    stringKeys: true,
  })

  // Walk the AST before conversion, including when the parser reports a duplicate key.
  checkDocumentNode(document.contents)

  if (document.errors.length > 0) {
    throw new WorkflowSchemaError(document.errors.map(error => ({ path: '$', message: error.message })))
  }
  if (document.directives?.yaml.version !== '1.2') {
    throw new WorkflowSchemaError([{ path: '$', message: 'Workflow source must use YAML 1.2' }])
  }

  return validateWorkflowDefinition(format === 'json' ? json : document.toJS({ maxAliasCount: 0 }))
}
