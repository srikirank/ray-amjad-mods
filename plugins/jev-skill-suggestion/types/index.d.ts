export type Mode = 'observe' | 'block' | 'steer'

// `plugin` is the plugin the skill's listing entry belongs to, or '' when it
// belongs to none (a built-in skill, or one found on disk).
export type Skill = { name: string; description: string; body: string; plugin: string }

export type Ranked = { name: string; probability: number }

export type Verdict = {
  text: string
  gate: number
  ranked: Ranked[]
  fits: Record<string, number>
  winner: string | null
  // The plugin names Jev judged relevant to the request. Empty means "do not
  // narrow": the listing stands and only the winner may load.
  relevant: string[]
  ms: number
}

declare module 'claude-code' {
  interface PluginState {
    'jev-skill-suggestion': {
      mode: Mode
      disabled: string[]
      roster: Skill[]
      verdict: Verdict | null
      status: string
    }
  }
}
