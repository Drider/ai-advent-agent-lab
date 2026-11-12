import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { compileScript, parse } from '@vue/compiler-sfc'
import { renderToString } from '@vue/server-renderer'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { createSSRApp } from 'vue'
import { describe, expect, it } from 'vitest'

const filename = join(process.cwd(), 'components/ChatRequestMetrics.vue')
const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
const script = compileScript(descriptor, { id: 'metrics-test', inlineTemplate: true })
const compiled = transpileModule(script.content, {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
}).outputText
const componentModule = { exports: {} as { default?: any } }
new Function('require', 'exports', 'module', compiled)(createRequire(import.meta.url), componentModule.exports, componentModule)

async function renderMetrics(props: Record<string, unknown>): Promise<string> {
  const html = await renderToString(createSSRApp(componentModule.exports.default, props))
  return html.replace(/<[^>]+>/gu, ' ').replace(/\s+/gu, ' ')
}

const metadata = {
  durationMs: 1500,
  usage: {
    inputTokens: 250, outputTokens: 42, totalTokens: 292,
    inputTokenDetails: { noCacheTokens: 55, cacheReadTokens: 175, cacheWriteTokens: 20 },
    outputTokenDetails: { textTokens: 30, reasoningTokens: 12 },
  },
  steps: [
    { usage: {
      inputTokens: 100, outputTokens: 12, totalTokens: 112,
      inputTokenDetails: { noCacheTokens: 25, cacheReadTokens: 75, cacheWriteTokens: 0 },
      outputTokenDetails: { textTokens: 10, reasoningTokens: 2 },
    } },
    { usage: {
      inputTokens: 150, outputTokens: 30, totalTokens: 180,
      inputTokenDetails: { noCacheTokens: 30, cacheReadTokens: 100, cacheWriteTokens: 20 },
      outputTokenDetails: { textTokens: 20, reasoningTokens: 10 },
    } },
  ],
}

describe('request token metrics', () => {
  it('shows only standard metrics by default and when details are disabled', async () => {
    for (const extraProps of [{}, { showDetailed: false }]) {
      const text = await renderMetrics({ metadata, showCost: false, ...extraProps })
      expect(text).toContain('Токены за ход: 292')
      expect(text).toContain('Вход за ход: 250')
      expect(text).toContain('Выход за ход: 42')
      expect(text).not.toContain('Чтение из кэша')
      expect(text).not.toContain('Размышления')
      expect(text).not.toContain('Обращение 1')
    }
  })

  it('shows cache, reasoning and separate model calls when enabled', async () => {
    const text = await renderMetrics({ metadata, showCost: false, showDetailed: true })
    expect(text).toContain('Вход без кэша: 55')
    expect(text).toContain('Чтение из кэша: 175')
    expect(text).toContain('Запись в кэш: 20')
    expect(text).toContain('Текст ответа: 30')
    expect(text).toContain('Размышления: 12')
    expect(text).toContain('Обращений к модели: 2')
    expect(text).toMatch(/Обращение 1.*Вход: 100.*Запись в кэш: 0.*Размышления: 2/u)
    expect(text).toMatch(/Обращение 2.*Вход: 150.*Размышления: 10/u)
  })

  it('renders old messages without inventing cache or reasoning counts', async () => {
    const text = await renderMetrics({
      metadata: { durationMs: 1000, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } },
      showCost: false,
      showDetailed: true,
    })
    expect(text).toContain('Токены за ход: 30')
    expect(text).toContain('Чтение из кэша: —')
    expect(text).toContain('Размышления: —')
    expect(text).not.toContain('Чтение из кэша: 0')
    expect(text).not.toContain('Обращение 1')
  })
})
