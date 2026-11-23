# think-aloud

A Claude Code plugin that reads Claude's thinking and replies aloud as they stream, as a small fixed team of voices:
without looking at the screen you can tell what kind of work is happening by who is speaking. The voice runs on
your Mac: free, offline, no API key.

## The voice

- **Kokoro** (Kokoro-82M, Apache 2.0): a natural neural voice that runs on your Mac's CPU, offline. It sets itself
  up the first time, in the background: a Python environment and the model, about 350 MB in `~/.claude/think-aloud`
  (nothing needs installing first: uv, Python 3.12, the libraries and the model all come from GitHub, checked against their SHA-256, in about a minute; PyPI only if GitHub fails).
  The status line shows its steps.
- Only Kokoro speaks: until it is ready speech waits, and a line it fails to play is tried once more, then left
  unsaid (the Mac voice used to step in and talk over it). `/speak engine say` uses the **Mac's own voice**
  instead, with a Mac voice for each member of the team; a voice your Mac lacks falls back to the system voice.

## The team

Seven fixed people, one per kind of work, the same in every session:

| Who | Role | Kokoro voice | Mac voice | Speaks for |
| --- | --- | --- | --- | --- |
| Maya | lead | af_heart | Samantha | Everything said to you: the visible reply |
| Theo | planner | bm_george | Daniel | Understanding the ask, planning, research (web, docs, reading code) |
| Kai | app | am_fenrir | Rishi | Front end and apps: UI code, mobile, web pages, styles, screenshots |
| Emma | backend | bf_emma | Karen | Servers, APIs, routes, services, schemas, migrations |
| Nora | data | af_bella | Tara (else Samantha) | Queries, notebooks, CSVs, metrics, reports, numbers |
| Sam | ops | am_puck | Aman (else Daniel) | Builds, deploys, git and GitHub, CI, infra, installs, devices |
| Isla | qa | bf_isabella | Moira (else Karen) | Tests, type checks, lint, code review, verifying a fix |

- **Replies are always Maya.** Thinking, and a short line for each tool call that changes something ("Deploy the
  backend.", "Editing routes.ts.", "I'll review the diff."), are spoken by whoever owns the work at that moment. A
  thinking block is never split between two people. Reads, searches and bookkeeping are not announced.
- **Who owns the work** is judged by a small Haiku call (the director) at each prompt and after tool calls, which
  also keeps a tiny task board: the status line shows `🔊 Sam · deploying the backend`. It never holds speech up:
  until it answers, the last answer stands.
- **Tables and code** are not read cell by cell: another small Haiku call (the narrator) says a small table the way
  an analyst would tell a colleague (the takeaway first), a big one as its gist, and a code block in one sentence or
  not at all. If it is slow or off: "There's a table on screen.", and code stays silent.
- The first time each person speaks in a session, they say who they are and their role ("Sam here, the ops
  engineer, on builds and deploys.").
- What is being said is shown in an amber band above the prompt ("🔊 Theo: …", with ⏮ and ⏭), and a reply block
  being spoken is lit amber in the transcript too. While a thought is spoken, the tool rows right under its "Thought
  for" row are lit too, in the fullscreen layout (`CLAUDE_CODE_NO_FLICKER=1 claude`). On the main screen (tmux by
  default) finished rows sit in the scrollback and are not redrawn, so there the band is where a thought is seen.
- **Nothing is read out word for word.** Thinking and replies are summed up by a third Haiku call (the synthesizer):
  all that waits of one person's paragraph or thought at once, saying only what is salient and new (a finding, a
  decision, a number, the idea of the method), as few words as the information needs. It sees the last few things said, so it does not
  repeat them, and stays silent when there is nothing new. If it is slow or fails, the first sentence or so is said.
- The director, the narrator and the synthesizer use your Claude Code session's own model access (Haiku, low effort,
  a few hundred tokens a call). `/speak classifier off` turns the director off; `/speak narrator off` turns the
  narrator and the synthesizer off, and speech is then read as written.

Also:

- Speech is cut into sentences as Claude writes them; markdown is cleaned so it sounds like speech (a path is its
  file name, a link is "a link").
- In live pace, speech keeps up with Claude: when it falls far behind, the action lines go first, then old thinking;
  replies are never dropped.
- Pressing Esc stops it at once. A new message does not: what is being said finishes, the old turn's waiting
  thinking and tool lines go, and speech follows Claude's new response.
- **Back**: `⇧←` (or the `⏮ back` button above the prompt, or `/speak back`) says the block before again, then the one that was playing, then carries on.
- **Next block**: `⇧→` (or the `⏭ next` row above the prompt while it speaks, or `/speak next`) skips the rest of
  what is being said: the whole thought, the reply's paragraph, table or code block, or the tool line. What comes
  after plays at once.
- Silent in headless `claude -p` runs and in subagents.

macOS only.

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

It is on as soon as it is installed, and starts speaking once Kokoro has set itself up (about a minute, once).

For the `⇧→` / `⇧←` shortcut (Shift+arrow), add this to `~/.claude/keybindings.json` (create the file if it is not there; merge
the entry if it is):

```json
{
  "$schema": "https://www.schemastore.org/claude-code-keybindings.json",
  "bindings": [{ "context": "Chat", "bindings": { "shift+right": "command:speak-next", "shift+left": "command:speak-back" } }]
}
```

`command:speak-next` and `command:speak-back` run think-aloud's silent `/speak-next` and `/speak-back`. ⌥→ / ⌥← stay free for jumping a word in the prompt. ⌘ is no good: most terminals keep it and never pass it on. Where ⇧→ does nothing, click ⏮ / ⏭ or type
`/speak back` / `/speak next`.

## Use

| Command | What it does |
| --- | --- |
| `/speak` | Shows the current settings |
| `/speak off` / `/speak on` | Turns it off or on (remembered across sessions) |
| `/speak stop` | Stops what is being said now |
| `/speak next` (`⇧→`) | Skips to the next block: the rest of this thought, paragraph, table or tool line goes |
| `/speak test` | Plays a sample line: Theo thinking, then Maya replying |
| `/speak cast` | Lists the team, their voices, who speaks now and the task board |
| `/speak cast <role> <voice>` | Gives a member a voice: a Kokoro name (`bf_emma`) or a Mac voice (`Moira`) |
| `/speak name <role> <name>` | Renames a member |
| `/speak voices` | Lists the voices (Kokoro's when it is running, else your Mac's English ones) |
| `/speak actions off` / `on` | The short lines for tool calls |
| `/speak intros off` / `on` | Each person saying who they are, once a session |
| `/speak classifier off` / `on` | The director (off: Theo speaks all the thinking) |
| `/speak narrator off` / `on` | The narrator (tables, code) and the synthesizer (all else): off, speech is read as written |
| `/speak thinking off` / `/speak replies off` | Read only one of the two |
| `/speak rate 220` | Words per minute (120 to 400); thinking runs a little faster |
| `/speak all` / `/speak live` | Read everything however far behind, or keep up with Claude (default) |
| `/speak engine kokoro` / `say` | The Kokoro voice (default) or the Mac voice |
| `/speak setup` | Checks the Kokoro voice and rebuilds what is broken |
| `/speak voice thinking <name>` / `voice reply <name>` | The planner's or the lead's voice (older form of `/speak cast`) |

Roles: `lead`, `planner`, `app`, `backend`, `data`, `ops`, `qa` (or the member's name). Nicer Mac voices (Premium /
Enhanced) are a free download in System Settings › Accessibility › Spoken Content › System voice › Manage Voices.

The design of the team is in `docs/cast.md`.
