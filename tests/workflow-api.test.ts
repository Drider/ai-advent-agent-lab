import { it, expect } from 'vitest'
import { stringify } from 'yaml'
import { workflow } from './task-workflow-fixture'
import { taskHttp } from './helpers/task-http'
const api = taskHttp()
it('validates without publishing, creates immutable versions and rejects concurrent publication', async () => {
  const json = { source: JSON.stringify(workflow), format: 'json' }
  const valid = await api.request('/workflows/validate', { source: stringify(workflow), format: 'yaml' })
  expect(valid).toMatchObject({ status: 200, json: { valid: true, definition: workflow } })
  const invalid = await api.request('/workflows/validate', { source: 'a: &tag 1', format: 'yaml' })
  expect(invalid).toMatchObject({ status: 422, json: { data: { valid: false, errors: [{ path: '$.a' }] } } })
  expect((await api.request('/workflows')).json.items).toHaveLength(3)
  const first = await api.request('/workflows', { ...json, name: 'Analysis' })
  expect(first).toMatchObject({ status: 200, json: { version: 1, hash: valid.json.hash } })
  const uri = '/workflows/' + first.json.workflowId
  expect((await api.request(uri + '/versions', { ...json, expectedVersion: 1 })).json.version).toBe(2)
  expect((await api.request(uri + '/versions', { ...json, expectedVersion: 1 })).status).toBe(409)
  expect((await api.request(uri + '?version=1')).json).toMatchObject({ workflow: { name: 'Analysis', latestVersion: 2 }, version: first.json })
  expect((await api.request(uri)).json.version.version).toBe(2)
  expect((await api.request(uri + '?version=3')).status).toBe(404)
  expect((await api.request(uri + '?version=1.2')).status).toBe(400)
  expect((await api.request('/workflows/validate', { ...json, publish: true })).status).toBe(400)
})
