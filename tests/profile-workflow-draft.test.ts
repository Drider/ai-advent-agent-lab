import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { effectScope, nextTick, reactive } from 'vue'
import { expect, it } from 'vitest'

it('keeps unsaved editor instructions after changing only the workflow on the server', async () => {
  const path = resolve('components/UserProfileEditor.vue')
  const { descriptor } = parse(readFileSync(path, 'utf8'), { filename: path })
  const script = compileScript(descriptor, { id: 'profile-workflow-draft' })
  const js = transpileModule(script.content, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const mod = { exports: {} as { default?: any } }
  new Function('require', 'exports', 'module', js)(createRequire(import.meta.url), mod.exports, mod)
  const props = reactive({ profile: { id: 'one', revision: 0, name: 'One', instructions: 'saved', defaultWorkflowId: null as string | null }, resetKey: 0 })
  const scope = effectScope()
  try {
    const editor = scope.run(() => mod.exports.default.setup(props, { expose() {}, emit() {} }))
    editor.instructions.value = 'local draft'
    props.profile = { ...props.profile, revision: 1, defaultWorkflowId: 'code' }
    await nextTick()
    expect(editor.instructions.value).toBe('local draft')
    expect(editor.dirty.value).toBe(true)
    expect(editor.selectedWorkflow.value).toBe('code')
  } finally { scope.stop() }
})
