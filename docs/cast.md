# The cast: a small team, one voice per stream of work

What the engineer should feel: Claude is a small team working on their problem. Without looking at the screen they
can tell *what kind of work is happening* by *who is speaking*, and the team never changes under them: the same
person always owns the same kind of work, in every session. Like a film's cast or a real team, it is small and
fixed, not a new voice per sentence.

## The team (fixed, seven people)

| Role (stream) | Name | Kokoro voice | Owns | Mac voice (`/speak engine say`) |
| --- | --- | --- | --- | --- |
| lead | Maya | af_heart | Everything said **to the user**: the visible reply text. The team's one face. | Samantha |
| planner | Theo | bm_george | Thinking that belongs to no specific stream yet: understanding the ask, planning, research (web, docs, reading and searching code) | Daniel |
| app | Kai | am_fenrir | Front end and apps: UI code, Android/iOS, web pages, CSS, layouts, screenshots, emulators/simulators | Rishi |
| backend | Emma | bf_emma | Servers, APIs, routes, services, schemas, migrations, server-side languages | Karen |
| data | Nora | af_bella | Data and analysis: queries (SQL, Mongo), notebooks, CSVs, metrics, reports, numbers | Tara (else Samantha) |
| ops | Sam | am_puck | Builds, deploys, git and GitHub, CI, Docker/infra, package installs, devices, shell plumbing | Aman (else Daniel) |
| qa | Isla | bf_isabella | Tests, type checks, linting, code review, verifying a fix, chasing a failure | Moira (else Karen) |

Voice choice: Kokoro's best-graded English voices, spread across American/British and female/male so any two
people in a row sound clearly different. If a voice is missing from the voices file, that role falls back to the
lead's voice for Kokoro, or the system voice for `say` (never silence).

## Who speaks what

1. **Reply text → Maya (lead), always.** One person talks to the user. Consistent and easy. The lead never speaks
   the work, so a reply always sounds different from the thinking before it.
2. **Thinking → whoever owns the work now**, as the director (below) last judged it; Theo (planner) at the very first
   turn, and always while the director is off. A thinking block is one person: its speaker is fixed when its first
   sentence is queued.
3. **Actions (short, optional, on by default) → whoever owns the work now.** When a tool call is complete,
   a one-line announcement, at most ~8 words, only for tools that change things or take time:
   - Bash: its `description` ("Sam: Deploy the backend.")
   - Edit / Write / MultiEdit / NotebookEdit: "Editing <file name>"
   - Agent / Task: the sub-task's `description`, said as taking it on ("Isla: I'll review the diff.")
   - WebSearch: "Searching for <query, cut to ~6 words>"; WebFetch: "Reading <host>"
   - Never: Read, Grep, Glob, LS, TodoWrite, ToolSearch and other bookkeeping (too frequent; it would be noise).
   Actions are the first thing dropped when speech falls behind (then stale thinking; replies never).
4. **Subagents stay silent** (parallel agents would talk over each other); the Agent announcement above is how the
   team member "takes" the sub-task.

## Deciding who speaks: the director (judgment, not pattern lists)

Code decides only the obvious (the four rules above). Which kind of work is happening is a judgment, so a model makes
it: pattern lists of paths and commands were brittle and tied to one kind of codebase (owner, 2026-11-22).

- **The director** is one small Haiku call (`$.model.complete`, `effort: "low"`, ~3 s timeout, abortable) that keeps
  the team's task board and picks who speaks. It is shown, in a few hundred tokens: the six working roles and what
  each owns (one line each), the user's latest prompt (cut to ~400 characters), the board (at most 4 entries: role,
  a short task like "deploying the backend", active / waiting / done), the last ~6 tool calls as one-line summaries
  (the tool and its description, file or command head, ~80 characters each), the start of the newest thinking or
  reply (~300 characters), and who is speaking now. It answers a small JSON object:
  `{"speaker":"ops","board":[{"role":"ops","task":"deploying the backend","status":"active"}]}`. It is told to keep
  the current speaker unless the work has clearly moved into another role's area, which is what keeps the voice
  steady. Its answer is read leniently (fenced JSON, trailing commas, a person's name for a role, a bare role); a
  pick of the lead, or anything unusable, leaves the speaker and the board as they were.
- **When it runs:** at each user prompt (`turn.start`, which carries the prompt's text), and at a step boundary after
  tool results (each main-loop `turn.step` start with tool calls it has not seen yet). One call at a time, and no
  sooner than ~4 s after the last; a new prompt's call replaces one still running.
- **It never holds speech up.** Until it answers, the last answer stands; its answer takes effect from the next
  block (a new thinking block, the next action line). Any failure: nothing changes.
- **`/speak classifier off`** (or `director off`): no director calls; Theo speaks all the thinking and the actions.

## Tables and code: the narrator

A table read line by line came out as "cell, cell, cell", and code blocks were dropped: neither is how a person would
say it (owner, 2026-11-22).

- **Held whole.** The sentence splitter keeps a run of table lines (lines starting with `|`) until its first line
  that is not a row, and a fenced code block until its closing fence (or the end of the block), instead of speaking
  them line by line or dropping them. A run counts as a table only with two lines or more, one of them with two
  cells or more (a lone `| grep x` is prose); a fence closes only with at least as many backticks as opened it, and
  a line like ```` ```x``` ```` opens none. Prose and short bullets stream sentence by sentence as before.
- **One item, in its place.** The held block becomes one queue item, spoken by the block's speaker (reply → Maya,
  thinking → its owner). Whatever follows it waits behind it, so speech keeps the order of the screen.
- **Haiku decides how to say it** (`effort: "low"`, ~4 s timeout, cut by a hush, at most two blocks ahead of
  speech; a block live pace drops has its call cut): given the block and the sentence
  before it, a small simple table is said the way a sharp data analyst would read it to a colleague (the takeaway
  first, natural sentences, numbers rounded, no headers or separators, never "pipe" or "column"); a large one as its
  gist plus "the full table is on screen"; code as one short sentence on what it is or does, or nothing. Its words
  are spoken as given (trimmed, quotes and markdown removed); an empty answer skips the block.
- **Fallbacks:** on a timeout or a failure, a table is "There's a table on screen." and code is silent.
  `/speak narrator off` does the same without asking.
- **What Haiku is shown** (the director's and the narrator's questions) has obvious secrets taken out first (private
  keys, bearer tokens, common key formats, a password in a URL, the value of anything named like a key, token,
  secret or password), and the quoted content is framed as data, never instructions. Best effort, not a guarantee.

## Engagement, kept small

- **Introductions, once per session per person:** the first time someone speaks in a session, their first utterance
  starts with their name and stream in ≤ 5 words ("Sam here, on builds."). Maya's is "Maya here." `/speak intros off`.
- **The status line** names who is speaking and their task on the board: `🔊 Sam · deploying the backend` (their
  role when the board has no task for them: `🔊 Maya · lead`).
- **`/speak cast`** prints the team (name, role, voices, what each owns), who speaks the work now and the board.
  `/speak cast <role> <voice>` changes a voice (a Kokoro name like `bf_emma`, or a Mac voice like `Moira`);
  `/speak name <role> <name>` renames; both persist. `/speak actions on|off`, `intros on|off`,
  `classifier on|off`, `narrator on|off` persist with the other settings.
- **No sound effects, no chatter, no invented content:** the team only says what Claude wrote (thinking, reply, tool
  descriptions), and the narrator's retelling of a table or code block that is on screen. Introductions are the only
  words added.

## Consistency rules (the contract)

- The role → person → voice table is fixed and persisted; nothing is random.
- Replies are always Maya. A thinking block is always one person. An action is always the current owner's.
- Speaker changes happen only at block boundaries.
- When the cast cannot be used (Kokoro not ready), the same roles map to the Mac fallback voices above, so the
  team still sounds like the same seven people, just in Mac voices.
- All seven Kokoro voices above are in `voices-v1.0.bin` (checked 2026-11-22, 54 voices).
