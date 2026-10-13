# jev-skill-suggestion

A Claude Code mod that scores every skill against your prompt while you type, using [TypeSafe's Jev](https://docs.typesafe.ai/introduction), and lets you decide whether Claude picks skills itself, loads none, or may load only the skills of the plugins Jev judges relevant for this prompt — or only Jev's own pick, when it judges no plugin relevant.

![jev-skill-suggestion in a session: the Jev band above the prompt scoring commit-sweep at 0.99 for "commit all of this in separate commits and push it", the Jev skills pane with a mode switch and a checkbox per skill, and the four steps from typing to the mode deciding](diagram.png)

Claude Code picks a skill from a one-line listing of every skill it has. With a lot of skills, that listing gets truncated and the pick gets worse: it loads the wrong skill, or loads one when nothing fits.

This mod uses the two-request method from TypeSafe's [skill suggestion cookbook](https://docs.typesafe.ai/cookbooks/skill_suggestion):

1. **You type.** 600 ms after you stop, the draft goes to Jev. Nothing is sent to Claude.
2. **Jev ranks every skill.** One `Choice` question over every skill's description, plus three `Noul` questions on whether the prompt needs a skill at all, and — when the listing carries plugin skills — one `Choice` over the plugins. The plugins it names for this prompt are the only ones whose skills may load, and the only ones left in the listing Claude is shown; when it names none, only Jev's own pick may load and the listing is hidden. If the gate is under 0.30, no skill.
3. **Jev re-reads the top 3.** This time with the opening 700 characters of each `SKILL.md`, and a `fits` question for each. If none fits above 0.30, no skill.
4. **Your mode decides.**

A band above the prompt shows the gate, the top skills with their probabilities, and the pick.

## Modes

| Mode | What Claude sees | What loads |
| --- | --- | --- |
| `observe` | Its normal skill listing, minus skills you turned off | Whatever Claude picks |
| `block` | No skill listing | Nothing: the model's `Skill` calls are refused |
| `steer` | Only the skills of the plugins Jev named for this prompt, plus a hidden note naming Jev's pick; no skill listing at all when Jev names no plugin | Only those plugins' skills — or only Jev's pick, when it names no plugin |

Switch with `/jev observe`, `/jev block` or `/jev steer`, or the mode button in the band. `/jev` opens a pane with a checkbox per skill: a skill you untick is left out of Jev's ranking, out of Claude's listing, and refused if Claude asks for it. The mode and the unticked skills are kept across sessions.

Skills you type yourself as slash commands always run.

## API key

Get a key from the [TypeSafe console](https://console.typesafe.ai/keys). The mod reads the `apiKey` plugin option (stored in secure storage), or the `TYPESAFE_API_KEY` environment variable when the option is empty.

Each prompt you type is sent to `api.typesafe.ai` along with your skills' names, descriptions, and the first 700 characters of the top three `SKILL.md` files.

## Install

```
/plugin install jev-skill-suggestion --marketplace ray-amjad/claude-code-mods
```

Answer `y` to add the marketplace, then pick a scope.

## Develop

```
claude --plugin-dir ./jev-skill-suggestion
claude plugin validate .
claude plugin test .
```
