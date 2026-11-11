import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, RenderChildren } from 'claude-code'

import type { Last, Settings } from '../types'
import {
  DEFAULT_MODEL,
  GROQ_URL,
  errorText,
  groqBody,
  isPlainlyIn,
  isWordless,
  languageName,
  mark,
  mask,
  oneLine,
  promptFor,
  readGroq,
  splitHost,
  systemFor,
  unmask,
  visible,
} from './core'
import type { Reply } from './core'

const PLUGIN = 'groq-translate'
const COMMAND = 'translate'
// How much of a translation the band shows before it is cut.
const BAND_CHARS = 1500
// Translations kept for a prompt sent again, keyed by its masked text.
const CACHE_SIZE = 50
// Columns of the band's Typed / Sent labels.
const LABEL_COLUMNS = 7

// This session's choice; null until a command sets it, the options standing in.
// The plugin name is written out: the state library reads it as a literal.
const settings = atom({ plugin: 'groq-translate', key: 'settings' } as const, null, { shape: 'settings-1' })
const last = atom({ plugin: 'groq-translate', key: 'last' } as const, null, { shape: 'last-1' })
const isCollapsed = atom({ plugin: 'groq-translate', key: 'isCollapsed' } as const, false)
const isTranslating = atom({ plugin: 'groq-translate', key: 'isTranslating' } as const, false)
const isOptionsOpen = atom({ plugin: 'groq-translate', key: 'isOptionsOpen' } as const, false)

type Outcome = Pick<Last, 'sent' | 'outcome' | 'reason'>

// The Groq key ('' when none is set) and the model that translates.
type Setup = { key: string; model: string }

// The band's model picker: Groq models that translate well.
const MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']

function modelOptions(model: string): { value: string; label: string }[] {
  const listed = MODELS.map(m => ({ value: m, label: m }))

  return MODELS.includes(model) ? listed : [...listed, { value: model, label: model }]
}

const NO_KEY = `no Groq API key: set groqApiKey with /plugin configure ${PLUGIN}@${PLUGIN} in a terminal`
const LOST = 'the translation dropped some code or a path'

// ─── Helpers ────────────────────────────────────────────────────────────────

// Prompts a person wrote: typed, sent from a phone or the SDK host, or a
// plugin's sent as theirs. Notifications, peers and loops pass as they are.
function isTyped(origin: PromptOrigin | undefined): boolean {
  if (origin === undefined) return true
  switch (origin.kind) {
    case 'composer':
    case 'bridge':
    case 'sdk':
    case 'unclassified':
      return true
    case 'plugin':
      return origin.asUser === true
    default:
      return false
  }
}

async function current($: EngineInterface, fallback: Settings): Promise<Settings> {
  return ((await read($, settings)) as Settings | null) ?? fallback
}

async function save($: EngineInterface, next: Settings): Promise<void> {
  await update($, settings, () => next)
  showStatus($, next)
}

function showStatus($: EngineInterface, s: Settings): void {
  $.ui.status(s.enabled ? `Translate → ${s.language} · Groq` : undefined)
}

function clip(text: string): string {
  return text.length > BAND_CHARS ? `${text.slice(0, BAND_CHARS)}…` : text
}

// ─── Translating ───────────────────────────────────────────────────────────

// Replies kept for words sent again, least recently used dropped first.
type Cache = Map<string, Reply>

// Groq's reply for the masked words, or why there is none. The same words
// asked again, to the same model and language, cost no second call. `marks`,
// on a second try, names the placeholders the first reply lost.
async function ask(
  $: EngineInterface,
  masked: string,
  language: string,
  setup: Setup,
  cache: Cache,
  marks?: readonly string[],
): Promise<Reply | string> {
  const cacheKey = `${setup.model}\u0000${language}\u0000${marks ? 'again' : ''}\u0000${masked}`
  const hit = cache.get(cacheKey)
  if (hit !== undefined) {
    cache.delete(cacheKey)
    cache.set(cacheKey, hit)

    return hit
  }
  const r = await $.http.fetch(GROQ_URL, {
    method: 'POST',
    // The key rides a header, never the URL.
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${setup.key}` },
    body: groqBody(setup.model, systemFor(language, marks), promptFor(masked), Math.min(16_000, Math.max(1024, masked.length * 4))),
  })
  const reply = readGroq(r.status, r.text)
  if (reply.kind === 'error') return reply.reason
  cache.set(cacheKey, reply)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)

  return reply
}

// A reply as the prompt to send, or why it cannot be sent.
function settle(text: string, reply: Reply, spans: readonly string[]): Outcome {
  if (reply.kind === 'same') return { sent: text, outcome: 'same' }
  const sent = unmask(reply.text, spans)
  if (sent === undefined) return { sent: text, outcome: 'failed', reason: LOST }
  if (sent.trim() === '') return { sent: text, outcome: 'failed', reason: 'the translation came back empty' }

  return { sent, outcome: sent === text ? 'same' : 'translated' }
}

// The prompt in `language`, or as typed with why. Only what was typed is
// translated: the host's blocks around it go as they are. Whatever fails,
// the prompt goes as typed: Claude never translates it instead.
async function translate($: EngineInterface, text: string, language: string, setup: Setup, cache: Cache): Promise<Outcome> {
  const { head, body, tail } = splitHost(text)
  const words = body.trim()
  const lead = body.slice(0, body.indexOf(words))
  const trail = body.slice(lead.length + words.length)
  const whole = (o: Outcome): Outcome => (o.outcome === 'translated' ? { ...o, sent: head + lead + o.sent + trail + tail } : { ...o, sent: text })

  const masked = mask(words)
  if (isWordless(masked.text) || isPlainlyIn(language, masked.text)) return { sent: text, outcome: 'same' }
  if (setup.key === '') return { sent: text, outcome: 'failed', reason: NO_KEY }
  try {
    let reply = await ask($, masked.text, language, setup, cache)
    if (typeof reply === 'string') return { sent: text, outcome: 'failed', reason: reply }
    let done = settle(words, reply, masked.spans)
    if (done.reason === LOST) {
      // Asked once more, the placeholders named: most lost ones come back.
      reply = await ask($, masked.text, language, setup, cache, masked.spans.map((_, i) => mark(i)))
      if (typeof reply !== 'string') done = settle(words, reply, masked.spans)
    }

    return whole(done)
  } catch (err) {
    return { sent: text, outcome: 'failed', reason: errorText(err) }
  }
}

// ─── The command ───────────────────────────────────────────────────────────

type Command =
  | { kind: 'status' }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'toggle' }
  | { kind: 'model'; name: string }
  | { kind: 'language'; name: string }

function parse(args: string): Command {
  const arg = args.trim()
  const model = /^model(?:\s+(.*))?$/i.exec(arg)
  if (model) return { kind: 'model', name: (model[1] ?? '').trim() }
  if (arg === '' || /^status$/i.test(arg)) return { kind: 'status' }
  if (/^(on|start)$/i.test(arg)) return { kind: 'on' }
  if (/^(off|stop)$/i.test(arg)) return { kind: 'off' }
  if (/^toggle$/i.test(arg)) return { kind: 'toggle' }

  return { kind: 'language', name: languageName(arg) }
}

// Writes the Groq model setting as the /config menu would; the module reloads
// with it. The answer is what to tell the person.
async function setModel($: EngineInterface, value: string): Promise<string> {
  const done = `Translating with ${value} on Groq from now on.`
  try {
    const pattern = new RegExp(`^${PLUGIN}(@[^.]+)?\\.groqModel$`)
    const key = (await $.config.list()).find(row => pattern.test(row.key))?.key
    if (key === undefined) return 'The Groq model was not changed: its setting is not in /config.'
    const r = await $.config.set({ key, value })
    if (r.deny !== undefined) return `The Groq model was not changed: ${r.deny}`
  } catch (err) {
    return `The Groq model was not changed: ${errorText(err)}`
  }

  return done
}

async function modelCommand($: EngineInterface, name: string, setup: Setup): Promise<string> {
  if (name === '') {
    return `The Groq model translating is ${setup.model}. "/translate model <id>" changes it; "/translate model default" goes back to ${DEFAULT_MODEL}.`
  }

  return setModel($, /^default$/i.test(name) ? DEFAULT_MODEL : name)
}

// ─── Hooks ─────────────────────────────────────────────────────────────────

export const register: Register = (on, options) => {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')
  const defaults: Settings = {
    enabled: options.enabled !== false,
    language: languageName(text(options.language) !== '' ? text(options.language) : 'English'),
  }
  const setup: Setup = {
    key: text(options.groqApiKey),
    model: text(options.groqModel) !== '' ? text(options.groqModel) : DEFAULT_MODEL,
  }
  const cache: Cache = new Map()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description:
        'Translate your prompts with Groq before they are sent: "/translate off", "/translate on", "/translate <language>" or "/translate model <id>"',
      argumentHint: '[on | off | <language> | model <id>]',
    })
    showStatus($, await current($, defaults))

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const command = parse(e.args)
    const before = await current($, defaults)
    switch (command.kind) {
      case 'model':
        return { text: await modelCommand($, command.name, setup) }
      case 'status':
        break
      case 'on':
      case 'off':
      case 'toggle':
        await save($, { ...before, enabled: command.kind === 'toggle' ? !before.enabled : command.kind === 'on' })
        break
      case 'language':
        await save($, { enabled: true, language: command.name })
        break
    }
    await update($, isCollapsed, () => false)
    const after = await current($, defaults)
    const keyNote = setup.key === '' ? ` Warning: ${NO_KEY}; until then prompts go as typed.` : ''

    return {
      text: after.enabled
        ? `Translation is on: prompts are sent in ${after.language}, translated by ${setup.model} on Groq.${keyNote}`
        : 'Translation is off: prompts are sent as typed. "/translate on" turns it back on.',
    }
  }).catch(() => ({ text: `${PLUGIN}: the command failed; the debug log has why.` }))

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta || !isTyped(e.origin)) return next(e)
    // A slash line no command took, or a shell line, goes as typed.
    const typed = visible(e.text)
    if (typed === '' || /^[/!]/.test(typed)) return next(e)
    const s = await current($, defaults)
    if (!s.enabled) return next(e)

    // The prompt waits on the translation: the status line says so meanwhile.
    $.ui.status(`Translating → ${s.language}…`)
    await update($, isTranslating, () => true)
    const result = await translate($, e.text, s.language, setup, cache)
    await update($, isTranslating, () => false)
    showStatus($, s)
    // Kept as the person reads it, the host's blocks left out.
    await update($, last, () => ({ ...result, original: typed, sent: visible(result.sent), language: s.language }))
    await update($, isCollapsed, () => false)
    if (result.outcome === 'failed') {
      $.ui.toast(`Translation failed (${oneLine(result.reason ?? 'unknown', 120)}); sent your original text.`)
    }

    return next(result.outcome === 'translated' ? { ...e, text: result.sent } : e)
  }).catch(async ($, e, next) => {
    // Whatever failed, the prompt still goes as typed.
    await update($, isTranslating, () => false)

    return next(e)
  })

  // A band above the prompt: that translation is on, into which language and
  // by which model, and the last prompt as typed beside what Claude received.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await current($, defaults)
    if (e.props.hasSurvey || !s.enabled) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // Every surface but mobile draws a Select; there the command stands in.
    const Select = e.surface !== 'mobile' && 'Select' in elements ? elements.Select : undefined
    const shown = await read($, last)
    const isBusy = await read($, isTranslating)
    const isOpen = shown !== null && !(await read($, isCollapsed))
    const optionsOpen = await read($, isOptionsOpen)
    // The row's width less the label column and the band's own margin.
    const width = Math.max(30, e.props.bodyColumns - LABEL_COLUMNS - 2)

    const row = (label: string, body: RenderChildren) => (
      <Box key={label} flexDirection="row">
        <Box width={LABEL_COLUMNS} flexShrink={0}>
          <Text color="subtle">{label}</Text>
        </Box>
        <Box flexShrink={1}>{body}</Box>
      </Box>
    )

    const band = (
      <Box flexDirection="column" rowGap="xs">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" columnGap="sm">
            <Text color="suggestion" bold>
              ⇄ Translating into {s.language}
            </Text>
            <Text color="subtle">via Groq</Text>
          </Box>
          <Box flexDirection="row" columnGap="sm">
            <Button
              key="options"
              label={optionsOpen ? 'Done' : 'Options'}
              plain
              dimColor
              onPress={() => update($, isOptionsOpen, () => !optionsOpen)}
            />
            {shown === null ? null : isOpen ? (
              <Button key="collapse" label="Hide" plain dimColor onPress={() => update($, isCollapsed, () => true)} />
            ) : (
              <Button key="expand" label="Show last" plain dimColor onPress={() => update($, isCollapsed, () => false)} />
            )}
            <Button key="off" label="Turn off" plain dimColor onPress={() => save($, { ...s, enabled: false })} />
          </Box>
        </Box>
        {optionsOpen && Select === undefined ? (
          <Text color="subtle">Model: {setup.model}. Change it with /translate model &lt;id&gt;.</Text>
        ) : null}
        {optionsOpen && Select !== undefined ? (
          <Select
            key="model"
            label="Groq model"
            options={modelOptions(setup.model)}
            value={setup.model}
            onSelect={async (value: string) => $.ui.toast(await setModel($, value))}
          />
        ) : null}
        {setup.key === '' ? <Text color="warning">⚠ No Groq API key yet: {NO_KEY}. Until then prompts go as typed.</Text> : null}
        {isBusy ? (
          <Text color="subtle" italic>
            Translating your prompt…
          </Text>
        ) : shown === null ? (
          <Text color="subtle">What you type is sent to Claude in {s.language}.</Text>
        ) : !isOpen ? null : shown.outcome === 'translated' ? (
          <Box flexDirection="column">
            {row('Typed', <Text color="subtle">{oneLine(shown.original, width)}</Text>)}
            {row('Sent', <Text wrap="wrap">{clip(shown.sent)}</Text>)}
          </Box>
        ) : shown.outcome === 'same' ? (
          <Text color="subtle">✓ Sent as typed: already in {shown.language}.</Text>
        ) : (
          <Text color="warning">⚠ Sent as typed: translation failed ({oneLine(shown.reason ?? 'unknown', 80)}).</Text>
        )}
      </Box>
    )
    // What the plugins beneath draw goes under the band, never in its place.
    const below = await next(e)
    if (below === null || below === undefined) return band

    return (
      <Box flexDirection="column" gap={1}>
        {band}
        {below}
      </Box>
    )
  })
}
