// Translation for this session: on or off, and the language prompts are sent in.
export type Settings = { enabled: boolean; language: string }

// The last prompt typed, and what was actually sent to Claude.
export type Last = {
  original: string
  sent: string
  language: string
  // translated: sent in `language`; same: already in it, sent as typed;
  // failed: the translation failed, sent as typed.
  outcome: 'translated' | 'same' | 'failed'
  reason?: string
}

declare module 'claude-code' {
  interface PluginState {
    'groq-translate': {
      settings: Shaped<Settings | null>
      last: Shaped<Last | null>
      isCollapsed: boolean
      // Whether the band's model picker is open.
      isOptionsOpen: boolean
      // True while a prompt waits on its translation.
      isTranslating: boolean
    }
  }
}
