import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { gateOf, mergeRoster, parseListing, parseSkillMd } from '../hooks/register'

// A session over a mocked store, no skills on disk, and a Jev that ranks the
// first skill of the listing it was shown and says it fits. `plugin` picks the
// answer to the plugin question: a plugin name, `none_of_these`, or nothing at
// all (the question is answered but the answer is unusable).
async function start(
  $: Engine,
  on: On,
  store: Record<string, unknown>,
  options: { listing?: string; plugin?: string; pluginProbability?: number; omitPluginAnswer?: boolean } = {},
) {
  mock.store(on, store)
  mock.env(on, { HOME: '/nowhere', TYPESAFE_API_KEY: 'test-key' })
  mock.clock(on)
  on('fs.list', () => ({ value: [] }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.attachment', (_$, e) => ({ text: e.text }) as never)
  on('http.fetch', (_$, e) => {
    const body = JSON.parse(String(e.init?.body ?? '{}'))
    const questions = (body.questions ?? {}) as Record<string, { criteria?: Record<string, unknown> }>
    const answers: Record<string, unknown> = {}
    for (const key of Object.keys(questions)) {
      const criteria = Object.keys(questions[key]?.criteria ?? {})
      if (key === 'which') {
        // Answer over the names actually asked about, so a listing without the
        // default skill still shortlists only skills that exist.
        const choice = criteria.includes('herdr') ? 'herdr' : criteria[0]
        answers[key] = {
          type: 'choice',
          choice,
          probabilities: Object.fromEntries(criteria.map(name => [name, name === choice ? 0.9 : 0.1])),
        }
      } else if (key === 'plugins' && !options.omitPluginAnswer) {
        const choice = options.plugin && criteria.includes(options.plugin) ? options.plugin : 'none_of_these'
        answers[key] = {
          type: 'choice',
          choice,
          probabilities: Object.fromEntries(
            criteria.map(name => [name, name === choice ? (options.pluginProbability ?? 0.9) : 0.05]),
          ),
        }
      } else {
        answers[key] = { type: 'noul', noul: key === 'gate::prose_suffices' ? 0 : 0.9 }
      }
    }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) } } as never
  })
  await $.session.start({ cwd: '/nowhere', surface: null, isInteractive: false })
  await $.prompt.attachment({ type: 'skill_listing', text: options.listing ?? LISTING } as never)
}

const LISTING = 'The following skills are available:\n- herdr: Control Herdr.\n- linkedin: Posts.'

// The engine's own prompt.submit, which the mod's steer chain needs beneath it.
function answerSubmit(on: On) {
  on('prompt.submit', (_$, e) => ({ text: e.text }) as never)
}

// A listing with two skills of one plugin, a built-in, and a plugin skill
// whose description runs on over a second line.
const PLUGGED = [
  'The following skills are available:',
  '- acs:learn-next: Check watched videos',
  '  and suggest what to watch next.',
  '- acs:search: Search the school for videos.',
  '- dataviz: Make charts.',
  '- herdr: Control Herdr',
  '  from a right-hand pane.',
].join('\n')

// What the module's own listing parse makes of PLUGGED, for the fail-open test
// to compare a narrowed answer against.
const NARROWED_TO_ACS = [
  'The following skills are available:',
  '- acs:learn-next: Check watched videos',
  '  and suggest what to watch next.',
  '- acs:search: Search the school for videos.',
].join('\n')

test('parses inline, folded and quoted descriptions', () => {
  const folded = parseSkillMd('---\nname: commit-sweep\ndescription: >\n  Turn a messy tree\n  into commits.\n---\n# Body\nSteps.', 'dir')
  expect(folded?.name).toBe('commit-sweep')
  expect(folded?.description).toBe('Turn a messy tree into commits.')
  expect(folded?.body).toBe('# Body\nSteps.')
  const quoted = parseSkillMd('---\ndescription: "Say hi"\n---\n', 'hello')
  expect(quoted?.name).toBe('hello')
  expect(quoted?.description).toBe('Say hi')
  expect(parseSkillMd('no header', 'x')).toBe(null)
})

test('parses the engine skill listing, plugin names included', () => {
  const skills = parseListing(
    'The following skills are available:\n\n- agent-ready-api-audit\n- skill-creator:skill-creator: Create skills.\n  More detail.\n- herdr: Control Herdr.',
  )
  expect(skills.map(skill => skill.name)).toEqual(['agent-ready-api-audit', 'skill-creator:skill-creator', 'herdr'])
  expect(skills[1]?.description).toBe('Create skills. More detail.')
})

test('the listing decides who exists, the disk brings bodies', () => {
  const merged = mergeRoster(
    [
      { name: 'herdr', description: 'long', body: 'BODY', plugin: '' },
      { name: 'gone', description: '', body: '', plugin: '' },
    ],
    [
      { name: 'herdr', description: 'short', body: '', plugin: '' },
      { name: 'plug:in', description: 'p', body: '', plugin: 'plug' },
    ],
  )
  expect(merged).toEqual([
    { name: 'herdr', description: 'long', body: 'BODY', plugin: '' },
    { name: 'plug:in', description: 'p', body: '', plugin: 'plug' },
  ])
})

test('gate inverts prose_suffices', () => {
  expect(gateOf({ acts_on_user_system: 1, would_follow_documented_procedure: 1, prose_suffices: 1 })).toBe(2 / 3)
})

test('block mode refuses every model skill load', async ($, on) => {
  await start($, on, { mode: 'block' })
  expect((await $.tool.call({ tool: 'Skill', skill: 'herdr' })).deny).toMatch(/blocked/)
})

test('a disabled skill is refused in observe mode', async ($, on) => {
  await start($, on, { disabled: ['herdr'] })
  expect((await $.tool.call({ tool: 'Skill', skill: 'herdr' })).deny).toMatch(/turned off/)
})

test('steer adds the pick as hidden context and lets only it load', async ($, on) => {
  let context: readonly string[] = []
  on('prompt.submit', (_$, e) => {
    context = e.context ?? []
    return { text: e.text } as never
  })
  on('tool.call', { tool: 'Skill' }, () => ({ result: 'loaded' }) as never)
  await start($, on, { mode: 'steer' })
  await $.prompt.submit({ text: 'split the pane and run the tests' } as never)
  expect(context.join('')).toMatch(/Relevant to the current request: herdr/)
  expect((await $.tool.call({ tool: 'Skill', skill: 'linkedin' })).deny).toMatch(/herdr/)
  expect((await $.tool.call({ tool: 'Skill', skill: 'herdr' })).deny).toBe(undefined)
})

test('observe drops disabled skills from the listing, block hides it', async ($, on) => {
  await start($, on, { disabled: ['herdr'] })
  const observed = await $.prompt.attachment({ type: 'skill_listing', text: LISTING } as never)
  expect(observed.text).toBe('The following skills are available:\n- linkedin: Posts.')
  await $.command.run({ command: 'jev', args: 'block' } as never)
  const blocked = await $.prompt.attachment({ type: 'skill_listing', text: LISTING } as never)
  expect(blocked.text).toBe(null)
})

test('the pane toggles a skill off, and the model can no longer load it', async ($, on) => {
  await start($, on, {})
  const ui = await $.ui.mount({
    plugin: 'jev-skill-suggestion',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'jev-skill-suggestion',
    props: { title: 'Jev skills', isFocused: true, bodyColumns: 80, placement: 'dock' } as never,
  })
  expect((await ui.find({ key: 'toggle:herdr' }))?.text).toBe('[x]')
  await ui.press({ key: 'toggle:herdr' } as never)
  expect((await ui.find({ key: 'toggle:herdr' }))?.text).toBe('[ ]')
  expect((await $.tool.call({ tool: 'Skill', skill: 'herdr' })).deny).toMatch(/turned off/)
})

test('parseListing carries each entry\'s plugin, and none for a plain name', () => {
  const skills = parseListing(PLUGGED)
  expect(skills.map(skill => [skill.name, skill.plugin])).toEqual([
    ['acs:learn-next', 'acs'],
    ['acs:search', 'acs'],
    ['dataviz', ''],
    ['herdr', ''],
  ])
})

test("mergeRoster keeps the listing's plugin over the disk copy's blank one", () => {
  const merged = mergeRoster(
    [{ name: 'acs:learn-next', description: 'from disk', body: 'BODY', plugin: '' }],
    [{ name: 'acs:learn-next', description: 'from listing', body: '', plugin: 'acs' }],
  )
  expect(merged[0]?.plugin).toBe('acs')
  expect(merged[0]?.description).toBe('from disk')
  expect(merged[0]?.body).toBe('BODY')
})

test("steer narrows the listing to the plugins Jev named, continuations and all", async ($, on) => {
  answerSubmit(on)
  await start($, on, { mode: 'steer' }, { listing: PLUGGED, plugin: 'acs' })
  await $.prompt.submit({ text: 'find me a video about postgres' } as never)
  const attachment = await $.prompt.attachment({ type: 'skill_listing', text: PLUGGED } as never)
  expect(attachment.text).toBe(NARROWED_TO_ACS)
})

test('steer with an empty relevant leaves the listing exactly as the unpatched mod did', async ($, on) => {
  answerSubmit(on)
  await start($, on, { mode: 'steer' }, { listing: PLUGGED, plugin: 'none_of_these' })
  await $.prompt.submit({ text: 'find me a video about postgres' } as never)
  const attachment = await $.prompt.attachment({ type: 'skill_listing', text: PLUGGED } as never)
  expect(attachment.text).toBe(PLUGGED)
  // Jev named no plugin, so the guard keeps its old footing too.
  expect((await $.tool.call({ tool: 'Skill', skill: 'acs:search' })).deny).toMatch(/only the skill Jev picked/)
})

test('a plugin answer under the threshold fails open', async ($, on) => {
  answerSubmit(on)
  await start($, on, { mode: 'steer' }, { listing: PLUGGED, plugin: 'acs', pluginProbability: 0.1 })
  await $.prompt.submit({ text: 'find me a video about postgres' } as never)
  const attachment = await $.prompt.attachment({ type: 'skill_listing', text: PLUGGED } as never)
  expect(attachment.text).toBe(PLUGGED)
  expect((await $.tool.call({ tool: 'Skill', skill: 'acs:search' })).deny).toMatch(/only the skill Jev picked/)
})

test('a plugin answer missing from the reply fails open', async ($, on) => {
  answerSubmit(on)
  await start($, on, { mode: 'steer' }, { listing: PLUGGED, omitPluginAnswer: true })
  await $.prompt.submit({ text: 'find me a video about postgres' } as never)
  const attachment = await $.prompt.attachment({ type: 'skill_listing', text: PLUGGED } as never)
  expect(attachment.text).toBe(PLUGGED)
  expect((await $.tool.call({ tool: 'Skill', skill: 'acs:search' })).deny).toMatch(/only the skill Jev picked/)
})

test('a roster with no plugins at all never narrows', async ($, on) => {
  answerSubmit(on)
  await start($, on, { mode: 'steer' })
  await $.prompt.submit({ text: 'find me a video about postgres' } as never)
  const attachment = await $.prompt.attachment({ type: 'skill_listing', text: LISTING } as never)
  expect(attachment.text).toBe(LISTING)
})

test("steer loads a named plugin's sibling and refuses a skill outside it", async ($, on) => {
  on('tool.call', { tool: 'Skill' }, () => ({ result: 'loaded' }) as never)
  answerSubmit(on)
  await start($, on, { mode: 'steer' }, { listing: PLUGGED, plugin: 'acs' })
  await $.prompt.submit({ text: 'find me a video about postgres' } as never)
  // Jev's top-ranked skill here is herdr, outside the plugin it named; the
  // guard follows the plugin, so it is refused while its sibling loads.
  expect((await $.tool.call({ tool: 'Skill', skill: 'acs:search' })).deny).toBe(undefined)
  const denied = (await $.tool.call({ tool: 'Skill', skill: 'herdr' })).deny
  expect(denied).toMatch(/plugins Jev named/)
  expect(denied).toMatch(/acs/)
  expect((await $.tool.call({ tool: 'Skill', skill: 'dataviz' })).deny).toMatch(/plugins Jev named/)
})
