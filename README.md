# think-aloud

A Claude Code plugin that reads Claude's thinking and replies aloud as they stream, using the Mac's built-in
voices (`say`): free, offline, no API key.

- Thinking is read in one voice (Rishi), replies in another (Samantha), a sentence at a time as each one finishes.
- Code blocks, table rules and long file paths are skipped; markdown is cleaned so it sounds like speech.
- In live pace, stale thinking is skipped so the voice keeps up with Claude; replies are always read in full.
- Sending a new message or pressing Esc stops it at once.
- Silent in headless `claude -p` runs and in subagents.

macOS only (it uses `say`). If a voice isn't installed on your Mac, it falls back to the system voice.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install think-aloud --marketplace shashank42/claude-think-aloud
```

Answer `y` to add the marketplace, then pick the user scope so it loads in every session.

From a shell:

```
claude plugin install think-aloud --marketplace shashank42/claude-think-aloud
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with
`shashank42/claude-think-aloud`, then Add plugin.

It is on as soon as it is installed.

## Use

| Command | What it does |
| --- | --- |
| `/speak` | Shows the current settings |
| `/speak off` / `/speak on` | Turns it off or on (remembered across sessions) |
| `/speak stop` | Stops what is being said now |
| `/speak test` | Plays one sample line in each voice |
| `/speak voices` | Lists the English voices on your Mac |
| `/speak voice thinking <name>` | Voice for thinking |
| `/speak voice reply <name>` | Voice for replies |
| `/speak rate 220` | Words per minute (120 to 400) |
| `/speak thinking off` / `/speak replies off` | Read only one of the two |
| `/speak all` / `/speak live` | Read everything however far behind, or skip stale thinking (default) |

Nicer voices (Premium / Enhanced) are a free download in System Settings › Accessibility › Spoken Content ›
System voice › Manage Voices; pick one with `/speak voice reply <name>`.
