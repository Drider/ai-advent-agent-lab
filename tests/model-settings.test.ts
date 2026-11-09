import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('ModelSettings', () => {
  it('renders an accessible dashboard button link to the right of the model ID input', () => {
    const source = readFileSync(
      join(process.cwd(), 'components/ModelSettings.vue'),
      'utf8',
    )

    expect(source).toMatch(
      /<div class="model-settings__input-row">\s*<UInput[\s\S]*?\/>\s*<UButton[\s\S]*?href="https:\/\/polza\.ai\/dashboard\/models"[\s\S]*?icon="i-lucide-external-link"[\s\S]*?color="neutral"[\s\S]*?variant="outline"[\s\S]*?size="lg"[\s\S]*?square[\s\S]*?aria-label="Открыть дашборд моделей"[\s\S]*?\/>\s*<\/div>/,
    )
  })
})
