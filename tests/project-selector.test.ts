import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { createSSRApp, defineComponent, h } from 'vue'
import { describe, expect, it } from 'vitest'

const filename = join(process.cwd(), 'components/ProjectSelector.vue')
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
const script = compileScript(descriptor, { id: 'project-selector-test', inlineTemplate: true })
const compiled = transpileModule(script.content, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText
const componentModule = { exports: {} as { default?: any } }
new Function('require', 'exports', 'module', compiled)(createRequire(import.meta.url), componentModule.exports, componentModule)

const projects = ['Alpha', 'Beta'].map(name => ({
  id: name.toLowerCase(), name, revision: 0,
  createdAt: '2026-11-19T00:00:00.000Z', updatedAt: '2026-11-19T00:00:00.000Z',
}))

async function renderSelector(props: Record<string, unknown>): Promise<string> {
  const app = createSSRApp(componentModule.exports.default, { projects, ...props })
  app.component('NuxtLink', defineComponent({
    setup: (_, { slots }) => () => h('a', slots.default?.()),
  }))
  return (await renderToString(app)).replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ')
}

describe('dialogue project display', () => {
  it.each([undefined, 'beta', 'none'])('shows the saved project independently of the %s filter', async (modelValue) => {
    const text = await renderSelector({ assignedProjectId: 'alpha', modelValue })
    expect(text).toContain('Текущий диалог Проект: Alpha')
    expect(text).not.toContain('Подключить текущий диалог')
  })

  it('keeps an unassigned dialogue separate from the selected project filter', async () => {
    const text = await renderSelector({ modelValue: 'beta' })
    expect(text).toContain('Текущий диалог Без проекта')
    expect(text).toContain('Подключить текущий диалог')
  })

  it('does not show a saved assignment as missing while project names are unavailable', async () => {
    const text = await renderSelector({ assignedProjectId: 'alpha', projects: [] })
    expect(text).toContain('Текущий диалог Проект привязан')
    expect(text).not.toContain('Подключить текущий диалог')
  })
})
