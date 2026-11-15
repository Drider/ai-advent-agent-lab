import { createServer } from 'node:http'

const port = Number(process.env.MOCK_LLM_PORT ?? 4322)

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => typeof part === 'string' ? part : part?.text ?? '').join(' ')
}

function allText(messages) {
  return messages.map(message => contentText(message.content)).join('\n')
}

function answerFor(messages) {
  const text = allText(messages)
  const current = [...messages].reverse().find(message => message.role === 'user')
  const question = contentText(current?.content)
  const facts = {
    owner: /Ирина Белова/u.test(text),
    deadline: /18 декабря 2026/u.test(text),
    budget: /480 000/u.test(text),
    restriction: /облачные сервисы/u.test(text),
    decision: /Казани/u.test(text) && /расширение/u.test(text),
  }
  if (/Кто отвечает/u.test(question)) return facts.owner ? 'Ирина Белова' : 'Не знаю.'
  if (/крайний срок/u.test(question)) return facts.deadline ? '18 декабря 2026 года' : 'Не знаю.'
  if (/бюджет/u.test(question)) return facts.budget ? '480 000 рублей' : 'Не знаю.'
  if (/ограничение/u.test(question)) return facts.restriction ? 'Данные участников нельзя передавать в облачные сервисы.' : 'Не знаю.'
  if (/Какое решение/u.test(question)) return facts.decision ? 'Пилот только в Казани; расширение обсуждается после оценки результатов.' : 'Не знаю.'
  if (/учебный проект/u.test(question)) return 'Принято.'
  if (/чек-лист запуска/u.test(question)) return 'Чек-лист обычно включает подготовку, проверку рисков, запуск и критерии успеха.'
  if (/журнал рисков/u.test(question)) return 'Журнал рисков помогает отслеживать угрозы, владельцев и меры реагирования.'
  if (/критерий завершения/u.test(question)) return 'Критерий завершения задают как измеримое проверяемое условие успеха.'
  if (/обратную связь/u.test(question)) return 'Обратную связь собирают через опросы, интервью и анализ метрик.'
  if (/письменно/u.test(question)) return 'Письменная фиксация помогает синхронизировать участников и избежать разночтений.'
  return 'Принято, зафиксировал.'
}

function responseFor(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const text = allText(messages)
  let answer
  if (text.includes('Update the durable key-value memory')) {
    const previousMatch = text.match(/<previous_facts>([\s\S]*?)<\/previous_facts>/u)
    const previous = previousMatch?.[1]?.trim() || '{}'
    const current = text.match(/<new_user_message>([\s\S]*?)<\/new_user_message>/u)?.[1] ?? ''
    let facts
    try { facts = JSON.parse(previous) } catch { facts = {} }
    if (/учебный проект/u.test(current) && /Ирина Белова/u.test(current)) {
      facts.project = 'учебный проект «Маяк»'
      facts.owner = 'Ирина Белова'
    }
    if (/18 декабря 2026/u.test(current)) facts.deadline = '18 декабря 2026 года'
    if (/480 000/u.test(current)) facts.budget = '480 000 рублей'
    if (/облачные сервисы/u.test(current)) facts.restriction = 'данные участников нельзя передавать в облачные сервисы'
    if (/Казани/u.test(current) && /расширение/u.test(current)) facts.decision = 'пилот только в Казани; расширение после оценки результатов'
    answer = JSON.stringify(facts)
  } else if (text.includes('Create a durable, standalone summary')) {
    answer = 'Факты проекта: учебный проект «Маяк»; ответственная — Ирина Белова; крайний срок — 18 декабря 2026 года; бюджет — 480 000 рублей; данные участников нельзя передавать в облачные сервисы; пилот только в Казани, расширение после оценки результатов.'
  } else {
    answer = answerFor(messages)
  }
  const inputTokens = Math.max(1, Math.ceil(text.length / 4))
  const outputTokens = Math.max(1, Math.ceil(answer.length / 4))
  return { answer, usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }
}

function sendJson(response, body) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function sendStream(response, id, model, result) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const write = chunk => response.write(`data: ${JSON.stringify(chunk)}\n\n`)
  write({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: result.answer }, finish_reason: null }] })
  write({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: result.usage })
  response.end('data: [DONE]\n\n')
}

const server = createServer((request, response) => {
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404)
    response.end('not found')
    return
  }
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const id = `mock-${Date.now()}`
      const result = responseFor(body)
      if (body.stream === true) sendStream(response, id, body.model ?? 'mock-model', result)
      else sendJson(response, {
        id,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? 'mock-model',
        choices: [{ index: 0, message: { role: 'assistant', content: result.answer }, finish_reason: 'stop' }],
        usage: result.usage,
      })
    } catch (error) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'invalid request' } }))
    }
  })
})

server.listen(port, '127.0.0.1', () => console.log(`mock OpenAI provider listening on http://127.0.0.1:${port}/v1`))
