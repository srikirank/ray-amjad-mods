import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Mode, Ranked, Skill, Verdict } from '../types'

// The two-request approach of docs.typesafe.ai/cookbooks/skill_suggestion:
// rank every skill and ask whether the request needs one at all, then re-read
// the top three with their SKILL.md openings and check each one really fits.
const API = 'https://api.typesafe.ai/v1/systemone'
const MODEL = 'jev-latest'
const SHORTLIST = 3
const EXCERPT_CHARS = 700
const GATE_THRESHOLD = 0.3
const FITS_THRESHOLD = 0.3
// A plugin only narrows the listing when Jev picks it this confidently.
const PLUGIN_THRESHOLD = 0.3
const PLUGIN_SKILL_CHARS = 160
const PLUGIN_CRITERION_CHARS = 400
const NO_PLUGIN = 'none_of_these'
const DEBOUNCE_MS = 600
const MIN_CHARS = 8
const PANE = 'jev-skill-suggestion'
const MODES: Mode[] = ['observe', 'block', 'steer']

const GATE_QUESTIONS: Record<string, string> = {
  acts_on_user_system:
    "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
  would_follow_documented_procedure:
    'Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?',
  prose_suffices:
    "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
}
const INVERTED = new Set(['prose_suffices'])

const mode = atom({ plugin: 'jev-skill-suggestion', key: 'mode' } as const, 'observe')
const disabled = atom({ plugin: 'jev-skill-suggestion', key: 'disabled' } as const, [])
const roster = atom({ plugin: 'jev-skill-suggestion', key: 'roster' } as const, [])
const verdict = atom({ plugin: 'jev-skill-suggestion', key: 'verdict' } as const, null)
const status = atom({ plugin: 'jev-skill-suggestion', key: 'status' } as const, '')

const unquote = (value: string) => value.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')

// Enough YAML for a SKILL.md header: `name`, and a `description` that is
// inline, quoted, folded (`>`) or literal (`|`), continued on indented lines.
export function parseSkillMd(text: string, fallbackName: string): Skill | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null
  const lines = (match[1] ?? '').split(/\r?\n/)
  const field = (key: string) => {
    const at = lines.findIndex(line => line.startsWith(`${key}:`))
    if (at === -1) return ''
    const head = (lines[at] ?? '').slice(key.length + 1).trim()
    const rest: string[] = []
    for (const line of lines.slice(at + 1)) {
      if (!/^\s+\S/.test(line)) break
      rest.push(line.trim())
    }
    const parts = /^[|>][-+]?$/.test(head) ? rest : [head, ...rest]
    return unquote(parts.join(' '))
  }
  const name = field('name') || fallbackName
  return { name, description: field('description'), body: (match[2] ?? '').trim().slice(0, EXCERPT_CHARS), plugin: '' }
}

// The plugin a listing entry belongs to: the text before its first colon.
// `acs:learn-next` is a skill of plugin `acs`; `dataviz` belongs to none.
export function pluginOf(name: string): string {
  const at = name.indexOf(':')
  return at === -1 ? '' : name.slice(0, at)
}

// The engine's skill listing: `- name: description` per skill, a description
// sometimes running on over following lines. Plugin skills carry `plugin:`.
export function parseListing(text: string): Skill[] {
  const skills: Skill[] = []
  for (const line of text.split('\n')) {
    const entry = line.match(/^- (\S+?)(?:: (.*))?$/)
    const last = skills[skills.length - 1]
    if (entry?.[1]) {
      // The name stays fully qualified: that is what the model passes back.
      const name = entry[1].replace(/:$/, '')
      skills.push({ name, description: entry[2] ?? '', body: '', plugin: pluginOf(name) })
    } else if (last && line.trim() && !line.startsWith('The following')) {
      last.description += ` ${line.trim()}`
    }
  }
  return skills
}

// Disk skills bring their SKILL.md body; the listing brings the plugin and
// built-in ones the disk scan cannot see. The listing decides who exists, and
// it alone carries the plugin: a disk copy never overwrites it with ''.
export function mergeRoster(disk: Skill[], listed: Skill[]): Skill[] {
  if (listed.length === 0) return disk
  const byName = new Map(disk.map(skill => [skill.name, skill]))
  return listed.map(skill => {
    const local = byName.get(skill.name)
    return local
      ? { ...skill, description: local.description || skill.description, body: local.body, plugin: skill.plugin }
      : skill
  })
}

// The listing as the model reads it, with only the named plugins' entries left
// in. Every non-entry line stays: the header, blank lines, and the continuation
// lines of an entry that was kept. A dropped entry takes its own continuations
// with it.
export function narrowListing(text: string, relevant: readonly string[]): string {
  const keep = new Set(relevant)
  const kept: string[] = []
  let state: 'kept' | 'dropped' | 'plain' = 'plain'
  for (const line of text.split('\n')) {
    // Read the entry's name the way parseListing does, so the set offered and
    // the set loadable agree entry for entry.
    const entry = line.match(/^- (\S+?)(?:: |$)/)
    if (entry?.[1]) state = keep.has(pluginOf(entry[1].replace(/:$/, ''))) ? 'kept' : 'dropped'
    else if (line.trim() === '') state = 'plain'
    if (state !== 'dropped') kept.push(line)
  }
  return kept.join('\n')
}

export function gateOf(values: Record<string, number>): number {
  const oriented = Object.entries(values).map(([key, value]) => (INVERTED.has(key) ? 1 - value : value))
  return oriented.length === 0 ? 0 : oriented.reduce((a, b) => a + b, 0) / oriented.length
}

const runtime: {
  apiKey: string
  asked: number
  disk: Skill[]
  listed: Skill[]
  // The text of the last prompt submitted in steer mode whose verdict this
  // session actually holds; '' whenever no verdict matches a live prompt.
  submitted: string
  timer?: { cancel: () => void }
} = { apiKey: '', asked: 0, disk: [], listed: [], submitted: '' }

async function ask($: Engine, state: unknown, questions: Record<string, unknown>) {
  const response = await $.http.fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${runtime.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: MODEL, questions }),
  })
  if (!response.ok) throw new Error(`Jev ${response.status}: ${response.text.slice(0, 160)}`)
  return JSON.parse(response.text).answers as Record<
    string,
    { choice?: string; probabilities?: Record<string, number>; noul?: number }
  >
}

const suggest = async ($: Engine, text: string): Promise<Verdict> => {
  const startedAt = await $.clock.now()
  const off = new Set(await read($, disabled))
  const skills = (await read($, roster)).filter(skill => !off.has(skill.name))
  const state = { request: text, recent_context: '' }
  if (skills.length === 0) {
    return { text, gate: 0, ranked: [], fits: {}, winner: null, relevant: [], ms: 0 }
  }

  // Which plugins this session could narrow a listing to, and which skills
  // each one brings: the criterion Jev reads instead of the plugin name.
  const plugins = [...new Set(skills.map(skill => skill.plugin).filter(plugin => plugin !== ''))]
  const wideQuestions: Record<string, unknown> = {
    which: {
      type: 'choice',
      instructions: "Which of these skills, if any, is the right one to load to help with the user's latest request?",
      criteria: Object.fromEntries(skills.map(skill => [skill.name, skill.description.slice(0, 250) || skill.name])),
    },
  }
  if (plugins.length > 0) {
    wideQuestions.plugins = {
      type: 'choice',
      instructions:
        "Which of these plugins, if any, provides a skill needed for the user's latest request? Choose none_of_these if the request needs no plugin skill.",
      criteria: {
        ...Object.fromEntries(
          plugins.map(plugin => [
            plugin,
            skills
              .filter(skill => skill.plugin === plugin)
              .map(skill => skill.description.slice(0, PLUGIN_SKILL_CHARS))
              .join(' ')
              .slice(0, PLUGIN_CRITERION_CHARS) || plugin,
          ]),
        ),
        [NO_PLUGIN]: 'No plugin skill is needed for this request.',
      },
    }
  }
  for (const [key, instructions] of Object.entries(GATE_QUESTIONS)) {
    wideQuestions[`gate::${key}`] = { type: 'noul', instructions }
  }
  const wide = await ask($, state, wideQuestions)
  // Fail open: anything short of a confident pick of a known plugin leaves the
  // listing alone and the guard on its old footing.
  const pluginPick = wide.plugins?.choice
  const relevant =
    pluginPick && pluginPick !== NO_PLUGIN && plugins.includes(pluginPick) &&
    (wide.plugins?.probabilities?.[pluginPick] ?? 0) >= PLUGIN_THRESHOLD
      ? [pluginPick]
      : []
  const ranked: Ranked[] = Object.entries(wide.which?.probabilities ?? {})
    .map(([name, probability]) => ({ name, probability }))
    .sort((a, b) => b.probability - a.probability)
  const gate = gateOf(
    Object.fromEntries(
      Object.entries(wide)
        .filter(([key]) => key.startsWith('gate::'))
        .map(([key, answer]) => [key.slice('gate::'.length), answer.noul ?? 0]),
    ),
  )
  const done = async (fits: Record<string, number>, winner: string | null): Promise<Verdict> => ({
    text,
    gate,
    ranked: ranked.slice(0, 12),
    fits,
    winner,
    relevant,
    ms: (await $.clock.now()) - startedAt,
  })
  if (gate < GATE_THRESHOLD) return done({}, null)

  const shortlist = ranked.slice(0, SHORTLIST).map(entry => skills.find(skill => skill.name === entry.name)!)
  const rerankQuestions: Record<string, unknown> = {
    which: {
      type: 'choice',
      instructions:
        "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.",
      criteria: Object.fromEntries(
        shortlist.map(skill => [skill.name, `${skill.description}${skill.body ? ` — ${skill.body}` : ''}`]),
      ),
    },
  }
  for (const skill of shortlist) {
    rerankQuestions[`fits::${skill.name}`] = {
      type: 'noul',
      instructions: `Does the skill '${skill.name}' do the specific thing the user's request asks for? It is described as: ${skill.description}`,
    }
  }
  const narrow = await ask($, state, rerankQuestions)
  const fits = Object.fromEntries(
    shortlist.map(skill => [skill.name, narrow[`fits::${skill.name}`]?.noul ?? 0]),
  )
  const best = Math.max(...Object.values(fits))
  return done(fits, best < FITS_THRESHOLD ? null : (narrow.which?.choice ?? null))
}

// The plugins a listing may be narrowed to, as both the listing and the guard
// read them: those of the last submitted prompt's own verdict, and nothing
// otherwise. An empty answer always means "do not narrow".
const narrowing = async ($: Engine): Promise<string[]> => {
  const result = await read($, verdict)
  if (!runtime.submitted || result?.text !== runtime.submitted) return []
  return result.relevant
}

// Scores the draft; a newer draft's answer wins, an older one is dropped.
const score = async ($: Engine, text: string) => {
  const ticket = ++runtime.asked
  if (!runtime.apiKey) {
    await update($, status, () => 'no API key: set TYPESAFE_API_KEY or the plugin option')
    return null
  }
  await update($, status, () => 'scoring…')
  try {
    const result = await suggest($, text)
    if (ticket === runtime.asked) {
      await update($, verdict, () => result)
      await update($, status, () => '')
    }
    return result
  } catch (error) {
    if (ticket === runtime.asked) await update($, status, () => String((error as Error).message ?? error))
    return null
  }
}

const scanDisk = async ($: Engine, cwd: string) => {
  const home = (await $.env.get('HOME')) ?? ''
  const found: Skill[] = []
  for (const root of [`${home}/.claude/skills`, `${cwd}/.claude/skills`]) {
    const entries = await $.fs.list(root).catch(() => [])
    for (const entry of entries) {
      if (entry.kind !== 'dir' && !entry.isLink) continue
      const text = await $.fs.read(`${root}/${entry.name}/SKILL.md`).catch(() => null)
      const skill = typeof text === 'string' ? parseSkillMd(text, entry.name) : null
      if (skill && !found.some(other => other.name === skill.name)) found.push(skill)
    }
  }
  return found
}

const setMode = async ($: Engine, next: Mode) => {
  await update($, mode, () => next)
  await $.store.set('mode', next)
  $.ui.invalidate('prompt.attachment')
}

const toggle = async ($: Engine, name: string) => {
  const list = await update($, disabled, list =>
    list.includes(name) ? list.filter(one => one !== name) : [...list, name],
  )
  await $.store.set('disabled', list)
  $.ui.invalidate('prompt.attachment')
}


export const register: Register = (on, options) => {
  runtime.apiKey = typeof options.apiKey === 'string' ? options.apiKey : ''

  on('session.start', async ($, e, next) => {
    runtime.apiKey ||= (await $.env.get('TYPESAFE_API_KEY')) ?? ''
    const storedMode = await $.store.get('mode')
    if (typeof storedMode === 'string' && MODES.includes(storedMode as Mode)) {
      await update($, mode, () => storedMode as Mode)
    }
    const storedDisabled = await $.store.get('disabled')
    if (Array.isArray(storedDisabled)) await update($, disabled, () => storedDisabled.map(String))
    runtime.disk = await scanDisk($, e.cwd)
    await update($, roster, () => mergeRoster(runtime.disk, runtime.listed))
    await $.command.register({
      name: 'jev',
      description: 'Jev skill scores: open the skills pane, or `/jev observe|block|steer`',
    })
    return next(e)
  })

  on('command.run', { command: 'jev' }, async ($, e) => {
    const arg = e.args.trim()
    if (MODES.includes(arg as Mode)) {
      await setMode($, arg as Mode)
      return { text: `Jev skills: mode is now ${arg}.` }
    }
    await $.ui.open({ id: PANE, title: 'Jev skills' })
    return { text: 'Jev skills pane opened.' }
  })

  // Live scoring as the person types, once the draft has been still a moment.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    if (box.text === e.text) return box
    runtime.timer?.cancel()
    const draft = box.text.trim()
    // Short drafts and slash commands keep the last verdict on show.
    if (draft.length < MIN_CHARS || draft.startsWith('/')) {
      runtime.asked++
      await update($, status, () => '')
      return box
    }
    runtime.timer = $.clock.after(DEBOUNCE_MS, () => void score($, draft))
    return box
  })

  // Steer: the winner rides along as a hidden context block on the prompt.
  on('prompt.submit', async ($, e, next) => {
    runtime.timer?.cancel()
    const text = e.text.trim()
    if ((await read($, mode)) !== 'steer' || text.startsWith('/') || text.length < MIN_CHARS) {
      // No verdict belongs to this prompt, so nothing may narrow against it.
      runtime.submitted = ''
      return next(e)
    }
    const known = await read($, verdict)
    const result = known?.text === text ? known : await score($, text)
    runtime.submitted = result?.text === text ? text : ''
    if (!result?.winner) return next(e)
    const note =
      `<skill_relevance>\nRelevant to the current request: ${result.winner}. ` +
      'Load it with the Skill tool before you start. Ignore this if it does not fit what the user actually asked for.\n</skill_relevance>'
    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  // The listing the model reads: learn the roster from it, then narrow it to
  // Jev's plugins (steer), hide it (block) or drop the disabled skills
  // (observe).
  on('prompt.attachment', { type: 'skill_listing' }, async ($, e, next) => {
    runtime.listed = parseListing(e.text)
    await update($, roster, () => mergeRoster(runtime.disk, runtime.listed))
    const current = await read($, mode)
    if (current === 'steer') {
      const relevant = await narrowing($)
      // Fail open: no plugin named means the prompt stands as it did before.
      if (relevant.length === 0) return next(e)
      return next({ ...e, text: narrowListing(e.text, relevant) })
    }
    if (current !== 'observe') return { text: null }
    const off = new Set(await read($, disabled))
    if (off.size === 0) return next(e)
    const kept = e.text
      .split('\n')
      .filter(line => {
        const entry = line.match(/^- (\S+?)(?::|$)/)
        return !entry?.[1] || !off.has(entry[1])
      })
      .join('\n')
    return next({ ...e, text: kept })
  })

  // The model's own skill loads: blocked outright, held to the steer pick,
  // and never a disabled skill. Steer's guard is the mirror of its listing: a
  // skill in one of the plugins Jev named loads, anything else does not, so
  // the model is never offered a skill it is about to be denied.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const name = e.skill
    const current = await read($, mode)
    if ((await read($, disabled)).includes(name)) {
      return { deny: `jev-skill-suggestion: the skill '${name}' is turned off. Carry on without it.` }
    }
    if (current === 'block') {
      return { deny: 'jev-skill-suggestion: skill loading is blocked in this session. Carry on without a skill.' }
    }
    if (current === 'steer') {
      const relevant = await narrowing($)
      if (relevant.length > 0) {
        if (!relevant.includes(pluginOf(name))) {
          return {
            deny:
              `jev-skill-suggestion: only skills of the plugins Jev named for this request may load ` +
              `(${relevant.join(', ')}), and '${name}' is not one of them.`,
          }
        }
        return next(e)
      }
      const pick = (await read($, verdict))?.winner
      if (pick !== name) {
        return { deny: `jev-skill-suggestion: only the skill Jev picked for this request may load${pick ? ` (${pick})` : ' (none)'}.` }
      }
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'jev-skill-suggestion: its guard failed.' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const result = await read($, verdict)
    const note = await read($, status)
    if (e.props.hasSurvey || (result === null && note === '')) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const current = await read($, mode)
    const width = Math.max(10, Math.min(24, e.props.bodyColumns - 50))
    const rows = Math.max(1, Math.min(5, e.props.maxRows - 2))
    const bar = (p: number) => '█'.repeat(Math.round(p * width)).padEnd(width, '·')
    const nextMode = MODES[(MODES.indexOf(current) + 1) % MODES.length] ?? 'observe'

    return (
      <Box flexDirection="column">
        <Box>
          <Box flexGrow={1}>
            <Text wrap="truncate-end">
              <Text bold color="magenta">
                Jev
              </Text>
              <Text dimColor> {current}</Text>
              {result && (
                <Text>
                  {' '}· gate <Text bold>{result.gate.toFixed(2)}</Text> ·{' '}
                  {current === 'steer' && result.relevant.length > 0 ? (
                    <Text color="green">
                      narrows to {result.relevant.join(', ')}
                      {result.winner ? ` (pick ${result.winner})` : ''}
                    </Text>
                  ) : result.winner ? (
                    <Text color="green">
                      {current === 'block' ? 'would load' : current === 'steer' ? 'loads' : 'pick'} {result.winner}
                    </Text>
                  ) : (
                    <Text dimColor>no skill</Text>
                  )}
                  <Text dimColor> · {result.ms}ms</Text>
                </Text>
              )}
              {note !== '' && <Text color="yellow"> {note}</Text>}
            </Text>
          </Box>
          <Button key="mode" hotkey="m" label={`mode: ${nextMode}`} onPress={() => setMode($, nextMode)} />
          <Button key="pane" hotkey="s" label="skills" onPress={() => $.ui.open({ id: PANE, title: 'Jev skills' })} />
        </Box>
        {result?.ranked.slice(0, rows).map(entry => (
          <Text key={entry.name} wrap="truncate-end" color={entry.name === result.winner ? 'green' : undefined}>
            {entry.probability.toFixed(2)} {bar(entry.probability)} {entry.name}
            {result.fits[entry.name] !== undefined ? (
              <Text dimColor> fits {result.fits[entry.name]?.toFixed(2)}</Text>
            ) : null}
          </Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const skills = await read($, roster)
    const off = new Set(await read($, disabled))
    const current = await read($, mode)
    const result = await read($, verdict)
    const probability = new Map(result?.ranked.map(entry => [entry.name, entry.probability]) ?? [])
    const sorted = [...skills].sort(
      (a, b) => (probability.get(b.name) ?? -1) - (probability.get(a.name) ?? -1) || a.name.localeCompare(b.name),
    )
    const columns = e.props.bodyColumns ?? 80

    return (
      <Box flexDirection="column">
        <Box>
          <Text>Mode </Text>
          {MODES.map(one => (
            <Button
              key={one}
              label={one}
              variant={one === current ? 'primary' : undefined}
              onPress={() => setMode($, one)}
            />
          ))}
        </Box>
        <Text dimColor>
          observe: Claude picks as usual · block: no skill loads · steer: only the skills of the plugins Jev
          names load, and only Jev's pick when it names none
        </Text>
        <Text dimColor>
          {skills.length} skills, {off.size} off{result ? ` · last: "${result.text.slice(0, 40)}"` : ''}
        </Text>
        {sorted.map(skill => (
          <Box key={skill.name}>
            <Button
              key={`toggle:${skill.name}`}
              plain
              label={off.has(skill.name) ? '[ ]' : '[x]'}
              onPress={() => toggle($, skill.name)}
            />
            <Text dimColor={off.has(skill.name)} wrap="truncate-end">
              {' '}
              {probability.has(skill.name) ? probability.get(skill.name)!.toFixed(2) : '    '}{' '}
              {skill.name}
              <Text dimColor> {skill.description.slice(0, Math.max(0, columns - skill.name.length - 14))}</Text>
            </Text>
          </Box>
        ))}
      </Box>
    )
  })
}
