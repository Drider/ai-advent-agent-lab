const baseUrl = (process.env.CHAT_URL ?? 'http://localhost:3000').replace(/\/$/u, '')
const model = process.env.LLM_MODEL ?? undefined
const contextWindowTokens = process.env.CONTEXT_WINDOW_TOKENS ? Number(process.env.CONTEXT_WINDOW_TOKENS) : undefined
const windowSize = process.env.CONTEXT_WINDOW_MESSAGES ? Number(process.env.CONTEXT_WINDOW_MESSAGES) : 10

const prompts = [
  'Это учебный проект «Маяк». Ответственная за него — Ирина Белова. Подтверди одной короткой фразой, без повторения деталей.',
  'Крайний срок проекта — 18 декабря 2026 года. Прими это к сведению и ответь коротко, не повторяя дату.',
  'Бюджет проекта — 480 000 рублей. Ответь коротко, не повторяя сумму.',
  'Есть жёсткое ограничение: данные участников нельзя передавать в облачные сервисы. Подтверди коротко, не повторяя формулировку.',
  'Решение принято: пилот проводим только в Казани, а расширение обсуждаем после оценки результатов. Подтверди коротко, без пересказа решения.',
  'Что обычно входит в чек-лист запуска? Ответь одним общим предложением, без сведений о нашем проекте.',
  'Для чего нужен журнал рисков? Ответь одним общим предложением, без сведений о нашем проекте.',
  'Как сформулировать критерий завершения пилота? Ответь одним общим предложением, без сведений о нашем проекте.',
  'Как обычно собирают обратную связь после пилота? Ответь одним общим предложением, без сведений о нашем проекте.',
  'Зачем фиксировать принятое решение письменно? Ответь одним общим предложением, без сведений о нашем проекте.',
  'Кто отвечает за учебный проект? Назови только имя и фамилию.',
  'Какой крайний срок проекта? Назови только дату.',
  'Каков бюджет проекта? Назови только сумму и валюту.',
  'Какое ограничение установлено для данных участников? Ответь одним предложением.',
  'Какое решение принято о месте пилота и расширении? Ответь одним предложением.',
]

const checks = [
  ['Ирина', 'Белова'],
  ['18', 'декабря', '2026'],
  ['480', '000'],
  ['облачные', 'сервисы'],
  ['Казани', 'расширение'],
]

async function json(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options)
  if (!response.ok) throw new Error(`${options?.method ?? 'GET'} ${path}: ${response.status} ${await response.text()}`)
  return response.json()
}

function textOf(message) {
  return message.parts.filter(part => part.type === 'text').map(part => part.text).join(' ')
}

function addUsage(total, usage) {
  if (!usage) return
  if (typeof usage.inputTokens === 'number') total.input += usage.inputTokens
  if (typeof usage.outputTokens === 'number') total.output += usage.outputTokens
  if (typeof usage.totalTokens === 'number') total.total += usage.totalTokens
}

async function run(strategy) {
  const session = await json('/api/sessions', { method: 'POST' })
  const settings = { strategy, windowSize, messageThreshold: 20 }
  await json(`/api/sessions/${session.id}/context-strategy`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) })
  const answers = []
  for (const prompt of prompts) {
    const message = { id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: prompt }] }
    const body = {
      kind: 'message', sessionId: session.id, requestId: crypto.randomUUID(), message,
      ...(model === undefined ? {} : { model }),
      contextStrategy: settings,
      compaction: { enabled: strategy === 'summary', messageThreshold: 20, ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }) },
    }
    const response = await fetch(`${baseUrl}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const responseBody = await response.text()
    if (!response.ok) throw new Error(`chat request failed: ${response.status} ${responseBody.slice(0, 500)}`)
    const detail = await json(`/api/sessions/${session.id}`)
    answers.push(detail.messages.filter(item => item.role === 'assistant').at(-1))
  }
  const detail = await json(`/api/sessions/${session.id}`)
  const usage = { input: 0, output: 0, total: 0 }
  let agentCalls = 0
  for (const message of detail.messages) {
    if (message.role !== 'assistant' || !message.metadata) continue
    agentCalls += 1
    addUsage(usage, message.metadata.usage)
  }
  let maintenanceCalls = 0
  for (const update of detail.factsUpdates ?? []) {
    maintenanceCalls += 1
    addUsage(usage, update.usage)
  }
  for (const attempt of detail.compactionAttempts ?? []) {
    maintenanceCalls += 1
    addUsage(usage, attempt.usage)
  }
  const remembered = checks.map((needles, index) => {
    const answer = textOf(answers[index + 10] ?? { parts: [] }).toLocaleLowerCase('ru-RU')
    return needles.every(needle => answer.includes(needle.toLocaleLowerCase('ru-RU')))
  })
  return { strategy, sessionId: session.id, remembered, rememberedCount: remembered.filter(Boolean).length, usage, agentCalls, maintenanceCalls }
}

const results = []
for (const strategy of ['sliding_window', 'sticky_facts', 'summary']) results.push(await run(strategy))
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, model, contextWindowTokens, windowSize, results }, null, 2))
