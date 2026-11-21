import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { createSSRApp, defineComponent, h } from 'vue'
import { expect, it } from 'vitest'

const filename = resolve('components/TaskStateCard.vue')
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
const script = compileScript(descriptor, { id: 'task-card', inlineTemplate: true })
const js = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
const compiled = { exports: {} as { default?: any } }
new Function('require', 'exports', 'module', js)(createRequire(import.meta.url), compiled.exports, compiled)
const base = { task: 'Отчёт', stage: 'planning', step: 'План', status: 'active', expected: { label: 'Подготовить план' }, artifacts: [] }
const artifact = { id: 'p', key: 'plan', version: 2, hash: 'unique', type: 'plan' }
async function card(task = {}, actions: unknown[] = [], approvals: unknown[] = []) {
  const app = createSSRApp(compiled.exports.default, { view: { task: { ...base, ...task }, actions, approvals, validations: [], recoveryOperations: [] }, busy: false })
  app.component('UButton', defineComponent({ setup: (_, { slots }) => () => h('button', slots.default?.()) }))
  return renderToString(app)
}
it('shows only available actions and leaves the questionnaire optional', async () => {
  const html = await card({}, [{ type: 'attach', label: 'Подключить процесс' }])
  expect(html).toContain('Без workflow')
  expect(html).toContain('Подключить workflow')
  expect(html).not.toContain('Заполните анкету')
  expect(html).not.toContain('Отменить задачу')
})
it('shows saved paused state, a pinned approval and the terminal result', async () => {
  expect(await card({ status: 'paused' })).toContain('planning')
  const approval = await card({}, [{ type: 'approve', approvalId: 'approval-1', label: 'Утвердить' }], [{ id: 'approval-1', artifact, status: 'pending' }])
  expect(approval).toContain('/task approve approval-1')
  expect(approval).toContain('plan · v2')
  expect(await card({ status: 'done', result: artifact })).toContain('Результат')
})
