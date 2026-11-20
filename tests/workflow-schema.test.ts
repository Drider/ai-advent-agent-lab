import { describe, expect, it } from 'vitest'
import { parseWorkflowSource } from '../server/workflows/parse'
import { validateWorkflowDefinition, workflowHash } from '../server/workflows/schema'
import type { WorkflowDefinition } from '../shared/workflow'

const fixture: WorkflowDefinition = {
  schemaVersion: 1,
  entryNodeId: 'work',
  resultArtifactKey: 'result',
  artifactSlots: [{ key: 'result', type: 'result' }],
  nodes: [
    {
      id: 'work',
      kind: 'work',
      stage: 'execution',
      label: 'Write the result',
      expected: { actor: 'agent', kind: 'artifact', label: 'Write the result', artifactKey: 'result' },
      allowedTools: ['read_file', 'rollDie'],
      writableArtifacts: ['result'],
      requiredApprovalKeys: [],
      checkIds: [],
    },
    {
      id: 'done',
      kind: 'success',
      stage: 'done',
      label: 'Finish',
      expected: { actor: 'agent', kind: 'result', label: 'Finish' },
      allowedTools: [],
      writableArtifacts: [],
      requiredApprovalKeys: [],
      checkIds: [],
    },
  ],
  transitions: [
    { id: 'advance', from: 'work', to: 'done', actor: 'agent', event: 'advance', guards: [], invalidateApprovalKeys: [] },
  ],
  checks: [{ id: 'result_exists', kind: 'fields', artifactKeys: ['result'], options: { fields: [] } }],
  completionCheckIds: ['result_exists'],
  contextExports: [],
}

const jsonFixture = JSON.stringify(fixture)
const yamlFixture = `
contextExports: []
completionCheckIds: [result_exists]
checks:
  - options: { fields: [] }
    artifactKeys: [result]
    kind: fields
    id: result_exists
transitions:
  - event: advance
    actor: agent
    guards: []
    invalidateApprovalKeys: []
    to: done
    from: work
    id: advance
nodes:
  - id: work
    kind: work
    stage: execution
    label: Write the result
    expected: { kind: artifact, label: Write the result, artifactKey: result, actor: agent }
    allowedTools: [read_file, rollDie]
    writableArtifacts: [result]
    requiredApprovalKeys: []
    checkIds: []
  - id: done
    kind: success
    stage: done
    label: Finish
    expected: { kind: result, label: Finish, actor: agent }
    allowedTools: []
    writableArtifacts: []
    requiredApprovalKeys: []
    checkIds: []
artifactSlots: [{ type: result, key: result }]
resultArtifactKey: result
entryNodeId: work
schemaVersion: 1
`

function rejectsAt(parse: () => unknown, path: string) {
  expect(parse).toThrow(expect.objectContaining({
    issues: expect.arrayContaining([expect.objectContaining({ path, message: expect.any(String) })]),
  }))
}

describe('workflow schema', () => {
  it('canonicalizes equivalent JSON and YAML', () => {
    expect(workflowHash(parseWorkflowSource(jsonFixture, 'json')))
      .toBe(workflowHash(parseWorkflowSource(yamlFixture, 'yaml')))
  })

  it('preserves array order in the hash', () => {
    const reordered = { ...fixture, nodes: [...fixture.nodes].reverse() }
    expect(workflowHash(reordered)).not.toBe(workflowHash(fixture))
  })

  it('accepts exactly 65,536 UTF-8 bytes', () => {
    const encoded = jsonFixture.padEnd(65_536)
    expect(parseWorkflowSource(encoded, 'json')).toEqual(fixture)
  })

  it('rejects additional properties in JSON arrays passed directly', () => {
    const invalid = structuredClone(fixture)
    invalid.checks[0]!.options = Object.assign([], { extra: true })
    rejectsAt(() => validateWorkflowDefinition(invalid), '$.checks[0].options')
  })

  it('accepts a reachable rework cycle', () => {
    const definition = structuredClone(fixture)
    definition.nodes.splice(1, 0, {
      ...definition.nodes[0]!,
      id: 'review',
      kind: 'validation',
      checkIds: ['result_exists'],
    })
    definition.transitions.push(
      { ...definition.transitions[0]!, id: 'rework', from: 'review', to: 'work' },
      { ...definition.transitions[0]!, id: 'pass', from: 'review' },
    )
    definition.transitions[0]!.to = 'review'

    expect(validateWorkflowDefinition(definition)).toEqual(definition)
  })

  it.each<{ name: string; edit: (input: WorkflowDefinition) => void; path: string }>([
    { name: 'a duplicate ID', edit: input => { input.nodes[1]!.id = 'work' }, path: '$.nodes[1].id' },
    { name: 'a missing initial node', edit: input => { input.entryNodeId = 'missing' }, path: '$.entryNodeId' },
    { name: 'an unreachable node', edit: input => { input.nodes.push({ ...input.nodes[0]!, id: 'unused' }) }, path: '$.nodes[2].id' },
    { name: 'an unknown transition target', edit: input => { input.transitions[0]!.to = 'missing' }, path: '$.transitions[0].to' },
    { name: 'an unknown check', edit: input => { input.completionCheckIds = ['missing'] }, path: '$.completionCheckIds[0]' },
    { name: 'an unknown tool', edit: input => { input.nodes[0]!.allowedTools = ['unknown_tool'] }, path: '$.nodes[0].allowedTools[0]' },
    { name: 'a task-control tool', edit: input => { input.nodes[0]!.allowedTools = ['finish_task'] }, path: '$.nodes[0].allowedTools[0]' },
    { name: 'empty completion checks', edit: input => { input.completionCheckIds = [] }, path: '$.completionCheckIds' },
    { name: 'no path to success', edit: input => { input.nodes[1]!.kind = 'work' }, path: '$.entryNodeId' },
    { name: 'an unknown result slot', edit: input => { input.resultArtifactKey = 'missing' }, path: '$.resultArtifactKey' },
    { name: 'an unsupported schema version', edit: input => { Object.assign(input, { schemaVersion: 2 }) }, path: '$.schemaVersion' },
    { name: 'an extra node field', edit: input => { Object.assign(input.nodes[0]!, { extra: true }) }, path: '$.nodes[0].extra' },
  ])('rejects $name', ({ edit, path }) => {
    const invalid = structuredClone(fixture)
    edit(invalid)
    rejectsAt(() => validateWorkflowDefinition(invalid), path)
  })

  it.each<{ name: string; format: 'json' | 'yaml'; source: string; path: string }>([
    { name: 'aliases', format: 'yaml', source: 'entryNodeId: *node', path: '$.entryNodeId' },
    { name: 'anchors', format: 'yaml', source: 'entryNodeId: &node work', path: '$.entryNodeId' },
    { name: 'duplicate YAML keys', format: 'yaml', source: 'entryNodeId: work\nentryNodeId: done', path: '$.entryNodeId' },
    { name: 'duplicate JSON keys', format: 'json', source: '{"entryNodeId":"work","entryNodeId":"done"}', path: '$.entryNodeId' },
    { name: 'duplicate JSON keys with different encodings', format: 'json', source: '{"nodes":[{"id":"work","\\u0069d":"done"}]}', path: '$.nodes[0].id' },
    { name: 'explicit YAML tags', format: 'yaml', source: 'entryNodeId: !custom work', path: '$.entryNodeId' },
    { name: 'standard YAML tags', format: 'yaml', source: 'entryNodeId: !!str work', path: '$.entryNodeId' },
    { name: 'prototype keys', format: 'yaml', source: '__proto__: {}', path: '$.__proto__' },
    { name: 'prototype keys escaped in JSON', format: 'json', source: '{"__pr\\u006fto__":{}}', path: '$.__proto__' },
    { name: 'nonfinite YAML values', format: 'yaml', source: 'schemaVersion: .inf', path: '$.schemaVersion' },
    {
      name: 'nesting at depth 21',
      format: 'yaml',
      source: `checks: ${'['.repeat(20)}null${']'.repeat(20)}`,
      path: `$.checks${'[0]'.repeat(19)}`,
    },
    { name: '65,537 UTF-8 bytes', format: 'yaml', source: `#${'é'.repeat(32_768)}`, path: '$' },
    { name: 'YAML syntax in JSON mode', format: 'json', source: '{entryNodeId: work}', path: '$' },
  ])('rejects $name before validating the schema', ({ format, source, path }) => {
    rejectsAt(() => parseWorkflowSource(source, format), path)
  })
})
