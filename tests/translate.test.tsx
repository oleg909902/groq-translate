// The translation pipeline with the world beneath the plugin simulated: Groq
// over http.fetch, the prompt entering the session, the status line and toasts.
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const BAND = {
  plugin: 'groq-translate',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const KEY = { options: { groqApiKey: 'gsk-test' } }

type Request = {
  url: string
  headers: Record<string, string>
  body: {
    model: string
    messages: { role: string; content: string }[]
    reasoning_effort?: string
    include_reasoning?: boolean
  }
  // The masked message Groq was sent.
  message: string
}

type World = {
  requests: Request[]
  // Calls to Claude's own model: there must never be one.
  modelCalls: number
  // What entered the session, as Claude will read it.
  entered: string[]
  status: (string | undefined)[]
  toasts: string[]
}

type Answer = string | { status: number; body: unknown }

// `reply` answers the masked message Groq was sent: its text, or a failure.
function world(on: On, reply: (message: string) => Answer = () => '<<SAME>>'): World {
  const w: World = { requests: [], modelCalls: 0, entered: [], status: [], toasts: [] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'translate' } }))
  on('session.model', () => ({ value: 'the-session-model' }))
  on('ui.status', (_, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    w.toasts.push(String(e.text))
    return { value: undefined }
  })
  on('model.complete', () => {
    w.modelCalls++
    return { value: { isAnswered: false, reason: 'api-error' as const, status: 500, error: 'unexpected' as const, usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }
  })
  on('http.fetch', (_, e) => {
    const body = JSON.parse(e.init?.body ?? '{}')
    const user = body.messages?.find((m: { role: string }) => m.role === 'user')?.content ?? ''
    const message = /<message>\n([\s\S]*)\n<\/message>/.exec(user)?.[1] ?? ''
    w.requests.push({ url: e.url, headers: { ...(e.init?.headers ?? {}) }, body, message })
    const r = reply(message)
    const answer = typeof r === 'string' ? { status: 200, body: { choices: [{ message: { content: r } }] } } : r
    return {
      value: { status: answer.status, ok: answer.status < 300, headers: {}, text: JSON.stringify(answer.body) },
    }
  })
  // The engine's own drawing above the prompt, beneath the plugin.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('prompt.submit', (_, e) => {
    w.entered.push(e.text)
    return { text: e.text }
  })

  return w
}

const RATE_LIMIT = { status: 429, body: { error: { message: 'Rate limit reached' } } }

async function start($: Engine) {
  await $.session.start({ cwd: '/code/app', surface: 'desktop', isInteractive: true })
}

async function type($: Engine, text: string) {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
}

async function command($: Engine, args: string) {
  return $.command.run({
    command: 'translate',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
}

test('a Russian prompt reaches Claude in English, code and paths kept out of Groq\'s reach', KEY, async ($, on) => {
  const w = world(on, m =>
    m === 'почини ⟦0⟧ в ⟦1⟧, потом запусти ⟦2⟧' ? 'fix ⟦0⟧ in ⟦1⟧, then run ⟦2⟧' : `unexpected: ${m}`,
  )
  await start($)
  await type($, 'почини parseConfig() в src/router.ts, потом запусти `npm test`')

  expect(w.requests.length).toBe(1)
  const r = w.requests[0]!
  expect(r.url).toBe('https://api.groq.com/openai/v1/chat/completions')
  expect(r.url).not.toContain('gsk-test')
  expect(r.headers.Authorization).toBe('Bearer gsk-test')
  expect(r.body.model).toBe('openai/gpt-oss-120b')
  expect(r.body.reasoning_effort).toBe('low')
  expect(r.body.include_reasoning).toBe(false)
  expect(r.body.messages[0]?.content).toContain('into English')
  expect(JSON.stringify(r.body)).not.toContain('src/router.ts')
  expect(JSON.stringify(r.body)).not.toContain('npm test')
  expect(w.entered).toEqual(['fix parseConfig() in src/router.ts, then run `npm test`'])
  expect(w.status.at(-1)).toBe('Translate → English · Groq')
  expect(w.modelCalls).toBe(0)

  // The band shows what was typed beside what was sent.
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /^via Groq$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^почини/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Sent$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'fix parseConfig() in src/router.ts, then run `npm test`' })).toBeDefined()
  await ui.press({ key: 'collapse' })
  expect(await ui.find({ type: 'Text', text: /^Typed$/ })).toBeUndefined()
  expect(await ui.find({ key: 'expand' })).toBeDefined()
  await ui.unmount()
})

test("the IDE's and the host's blocks go as they are, only the typed words translated", KEY, async ($, on) => {
  const opened = '<ide_opened_file>The user opened the file /code/app/a.ts in the IDE.</ide_opened_file>\n'
  const reminder = '<system-reminder>\nLinked sessions now: top = local_1 (idle).\n</system-reminder>\n\n'
  const w = world(on, m => (m === 'привет' ? 'hi' : `unexpected: ${m}`))
  await start($)
  await type($, `${opened}${reminder}привет`)

  expect(w.requests.length).toBe(1)
  expect(w.requests[0]?.message).toBe('привет')
  expect(w.entered).toEqual([`${opened}${reminder}hi`])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /^привет$/ })).toBeDefined()
  await ui.unmount()

  await type($, `${opened}fix the router please`)
  expect(w.requests.length).toBe(1)
})

test('an English prompt passes with no request', KEY, async ($, on) => {
  const w = world(on)
  await start($)
  await type($, 'Refactor the `foo_bar` helper in lib/util.py, please.')

  expect(w.requests.length).toBe(0)
  expect(w.entered).toEqual(['Refactor the `foo_bar` helper in lib/util.py, please.'])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /already in English/ })).toBeDefined()
  await ui.unmount()
})

test('a prompt Groq says is already in the target passes unchanged', KEY, async ($, on) => {
  const w = world(on, () => '<<SAME>>')
  await start($)
  await command($, 'German')
  await type($, 'Bitte erkläre the cache Funktion')

  expect(w.requests.length).toBe(1)
  expect(w.requests[0]?.body.messages[0]?.content).toContain('into German')
  expect(w.entered).toEqual(['Bitte erkläre the cache Funktion'])
})

test('a slash command, a shell line and a code-only prompt are never translated', KEY, async ($, on) => {
  const w = world(on, () => 'should not be used')
  await start($)
  await type($, '/compact оставь главное')
  await type($, '!ls папка')
  await type($, '```ts\nconst x = 1\n```')

  expect(w.requests.length).toBe(0)
  expect(w.entered).toEqual(['/compact оставь главное', '!ls папка', '```ts\nconst x = 1\n```'])
})

test('Groq failing sends the original, with a notice, and Claude never translates instead', KEY, async ($, on) => {
  const w = world(on, () => RATE_LIMIT)
  await start($)
  await type($, 'почему падает тест?')

  expect(w.entered).toEqual(['почему падает тест?'])
  expect(w.modelCalls).toBe(0)
  expect(w.toasts).toEqual(['Translation failed (Groq: HTTP 429, Rate limit reached); sent your original text.'])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /translation failed/ })).toBeDefined()
  await ui.unmount()
})

test('with no key, nothing goes to Groq, the original is sent, and the band says how to add one', async ($, on) => {
  const w = world(on, () => 'unused')
  await start($)
  await type($, 'привет')

  expect(w.requests.length).toBe(0)
  expect(w.modelCalls).toBe(0)
  expect(w.entered).toEqual(['привет'])
  expect(w.toasts[0]).toContain('no Groq API key')
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /No Groq API key yet/ })).toBeDefined()
  await ui.unmount()
  expect((await command($, 'status')).text).toContain('Warning: no Groq API key')
})

test('a reply that loses a placeholder twice falls back to the original', KEY, async ($, on) => {
  const w = world(on, () => 'Look at the file')
  await start($)
  await type($, 'посмотри src/index.ts')

  expect(w.requests.length).toBe(2)
  expect(w.requests[1]?.body.messages[0]?.content).toContain('exactly these placeholders: ⟦0⟧')
  expect(w.entered).toEqual(['посмотри src/index.ts'])
  expect(w.toasts[0]).toContain('dropped some code or a path')
})

test('a placeholder lost once comes back when Groq is asked again', KEY, async ($, on) => {
  let n = 0
  const w = world(on, () => (++n === 1 ? 'Look at the file' : 'Look at ⟦0⟧'))
  await start($)
  await type($, 'посмотри src/index.ts')

  expect(w.requests.length).toBe(2)
  expect(w.entered).toEqual(['Look at src/index.ts'])
  expect(w.toasts).toEqual([])
})

test('placeholders written back with spaces or look-alike brackets, or twice, are put back', KEY, async ($, on) => {
  const w = world(on, () => 'Fix 【1】 in ⟦ 0 ⟧, then check [[1]] again')
  await start($)
  await type($, 'почини src/a.ts в parseConfig()')

  expect(w.entered).toEqual(['Fix parseConfig() in src/a.ts, then check parseConfig() again'])
})

test('the same words sent again reuse the translation, with this prompt\'s own code', KEY, async ($, on) => {
  const w = world(on, m => (m === 'посмотри ⟦0⟧' ? 'Look at ⟦0⟧' : `unexpected: ${m}`))
  await start($)
  await type($, 'посмотри src/a.ts')
  await type($, 'посмотри src/b.ts')

  expect(w.requests.length).toBe(1)
  expect(w.entered).toEqual(['Look at src/a.ts', 'Look at src/b.ts'])
})

test('a failed translation is not cached', KEY, async ($, on) => {
  let fail = true
  const w = world(on, () => (fail ? RATE_LIMIT : 'Hello'))
  await start($)
  await type($, 'привет')
  fail = false
  await type($, 'привет')

  expect(w.requests.length).toBe(2)
  expect(w.entered).toEqual(['привет', 'Hello'])
})

test('a Groq model other than gpt-oss gets no reasoning options', { options: { groqApiKey: 'gsk-test', groqModel: 'qwen/qwen3.8-27b' } }, async ($, on) => {
  const w = world(on, () => 'Hello')
  await start($)
  await type($, 'привет')

  expect(w.requests[0]?.body.model).toBe('qwen/qwen3.8-27b')
  expect(w.requests[0]?.body.reasoning_effort).toBeUndefined()
  expect(w.requests[0]?.body.include_reasoning).toBeUndefined()
})

test('a prompt plainly in Russian asks no Groq when Russian is the target', KEY, async ($, on) => {
  const w = world(on, () => 'should not be used')
  await start($)
  await command($, 'ru')
  await type($, 'объясни функцию getEntry() в src/cache.ts')

  expect(w.requests.length).toBe(0)
  expect(w.entered.length).toBe(1)
})

test('the status line says a translation is under way, then the language', KEY, async ($, on) => {
  const w = world(on, () => 'Hello')
  await start($)
  await type($, 'привет')

  expect(w.status.slice(-2)).toEqual(['Translating → English…', 'Translate → English · Groq'])
})

test('/translate off and on switch it for the session; the status line follows', KEY, async ($, on) => {
  const w = world(on, () => 'Hello')
  await start($)

  expect((await command($, 'off')).text).toContain('Translation is off')
  expect(w.status.at(-1)).toBeUndefined()
  await type($, 'привет')
  expect(w.requests.length).toBe(0)
  expect(w.entered).toEqual(['привет'])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /Translating into/ })).toBeUndefined()
  await ui.unmount()

  expect((await command($, 'on')).text).toContain('in English, translated by openai/gpt-oss-120b on Groq')
  expect(w.status.at(-1)).toBe('Translate → English · Groq')
  await type($, 'привет')
  expect(w.entered.at(-1)).toBe('Hello')

  expect((await command($, 'de')).text).toContain('in German')
  expect(w.status.at(-1)).toBe('Translate → German · Groq')
})

test('off at session start when the setting says so', { options: { groqApiKey: 'gsk-test', enabled: false } }, async ($, on) => {
  const w = world(on, () => 'Hello')
  await start($)
  await type($, 'привет')

  expect(w.requests.length).toBe(0)
  expect(w.status.at(-1)).toBeUndefined()
})

// The mod's model row in /config, and what is written to it.
function modelRow(on: On) {
  const set: { key: string; value: unknown }[] = []
  on('config.list', () => ({
    value: [{ key: 'groq-translate@groq-translate.groqModel', label: 'Groq model', value: '' }] as never,
  }))
  on('config.set', (_, e) => {
    set.push({ key: e.key, value: e.value })
    return { value: e.value }
  })

  return set
}

test('/translate model writes the setting', KEY, async ($, on) => {
  world(on)
  const set = modelRow(on)
  await start($)

  expect((await command($, 'model')).text).toContain('The Groq model translating is openai/gpt-oss-120b')
  expect((await command($, 'model openai/gpt-oss-20b')).text).toBe('Translating with openai/gpt-oss-20b on Groq from now on.')
  expect((await command($, 'model default')).text).toBe('Translating with openai/gpt-oss-120b on Groq from now on.')
  expect(set).toEqual([
    { key: 'groq-translate@groq-translate.groqModel', value: 'openai/gpt-oss-20b' },
    { key: 'groq-translate@groq-translate.groqModel', value: 'openai/gpt-oss-120b' },
  ])
})

test('/translate model with no setting row changes nothing', KEY, async ($, on) => {
  world(on)
  on('config.list', () => ({ value: [] }))
  await start($)

  expect((await command($, 'model openai/gpt-oss-20b')).text).toContain('was not changed')
})

test('the band picks the Groq model', KEY, async ($, on) => {
  const w = world(on)
  const set = modelRow(on)
  await start($)

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ key: 'model' })).toBeUndefined()
  await ui.press({ key: 'options' })
  expect(await ui.find({ key: 'options' })).toMatchObject({ text: 'Done' })
  await ui.select({ key: 'model', value: 'openai/gpt-oss-20b' })
  await ui.unmount()

  expect(set).toEqual([{ key: 'groq-translate@groq-translate.groqModel', value: 'openai/gpt-oss-20b' }])
  expect(w.toasts[0]).toBe('Translating with openai/gpt-oss-20b on Groq from now on.')
})

test('a model set outside the list is offered in the picker', { options: { groqApiKey: 'gsk-test', groqModel: 'some/other-model' } }, async ($, on) => {
  world(on)
  await start($)

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'options' })
  expect(JSON.stringify(await ui.drawn())).toContain('some/other-model')
  await ui.unmount()
})

test('on mobile, where there is no picker, the options say which command to use', KEY, async ($, on) => {
  world(on)
  await start($)

  const ui = await $.ui.mount({ ...BAND, surface: 'mobile' })
  await ui.press({ key: 'options' })
  expect(await ui.find({ type: 'Text', text: /\/translate model/ })).toBeDefined()
  await ui.unmount()
})

test('the band draws on every surface', KEY, async ($, on) => {
  world(on, () => 'Hello')
  await start($)
  await type($, 'привет')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /^Hello$/ })).toBeDefined()
    expect(await ui.find({ key: 'off' })).toBeDefined()
    await ui.unmount()
  }
})

test('the band draws above what the plugins beneath it draw, and turns translation off', KEY, async ($, on) => {
  const w = world(on)
  await start($)
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /Translating into English/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /sent to Claude in English/ })).toBeDefined()
  await ui.press({ key: 'off' })
  expect(w.status.at(-1)).toBeUndefined()
  await ui.unmount()
})

test('words joined by a slash are translated; a path is kept', KEY, async ($, on) => {
  const w = world(on, m => (m === 'читать/писать ⟦0⟧ и ⟦1⟧' ? 'read/write ⟦0⟧ and ⟦1⟧' : `unexpected: ${m}`))
  await start($)
  await type($, 'читать/писать src/a.ts и docs/')

  expect(w.requests[0]?.message).toContain('читать/писать')
  expect(w.entered).toEqual(['read/write src/a.ts and docs/'])
})
