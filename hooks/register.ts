import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'
import { boardText, defaultCast, mergeCast, ROLES, roleOf, StepReader, Team, TEAM, trimBacklog, WORKERS, type Line, type Role, type TeamSettings, type Utterance } from './cast'
import { fallbackNarration, gistOf, narrationOf, narratorPrompt, spoken, synthOf, synthPrompt } from './speech'

/**
 * think-aloud: Claude's thinking and replies, spoken as they stream by a small fixed team of voices (docs/cast.md),
 * in Kokoro-82M's voices (local, free, offline), or the Mac's own `say`.
 *
 * Kokoro is set up by itself the first time (engine/setup.sh in the background: a Python environment and the model,
 * about 350 MB, under ~/.claude/think-aloud); `say` speaks until it is ready, and whenever the Kokoro server is not
 * up. Each session then starts one local voice server (engine/server.py) that keeps the model loaded and one audio
 * stream open, and prepares the next utterance while one plays.
 *
 * A `turn.step` hook reads the main loop's response as it arrives (subagents stay quiet) through a StepReader
 * (cast.ts), which cuts it into sentences the moment each one ends (speech.ts) and hands the team each tool call
 * once its arguments are whole. The reply is the lead's (Maya); thinking and the short action lines are spoken by
 * whoever owns the work, as a Haiku "director" judges it at each prompt and after tool calls; a table or code block
 * is said the way a person would say it, by a Haiku "narrator". Neither call ever holds speech up: until one
 * answers, the last answer stands. Nothing in the stream is changed or slowed: every chunk passes on before it is
 * read.
 *
 * In `live` pace (the default) speech keeps up with the model: when more than BACKLOG_MAX lines wait, the action
 * lines go first, then the oldest thinking (the reply's never). Sending a message, pressing Esc, or `/speak stop`
 * silences it at once. "Next" (⌘→ or ⌘←, the ⏭ above the prompt, or `/speak next`) skips the rest of what is being said:
 * the whole thought, the reply's paragraph, table or code block, or the action line; what follows plays at once.
 * `/speak` shows and changes the settings, kept across sessions.
 */

/** What `/speak` changes ($.store, across sessions). */
export type Settings = TeamSettings & {
  on: boolean
  /** kokoro (set up by itself, falls back to say) or the Mac's own say. */
  engine: 'kokoro' | 'say'
  /** The reply's words per minute; thinking and actions run THINKING_FASTER of it. */
  rate: number
}

export const DEFAULTS: Settings = {
  on: true,
  engine: 'kokoro',
  thinking: true,
  replies: true,
  actions: true,
  intros: true,
  director: true,
  narrator: true,
  rate: 200,
  pace: 'live',
  cast: defaultCast(),
}

const STORE_KEY = 'settings'
const THINKING_FASTER = 1.15
/** Lines already waiting are said together up to this many characters (one natural utterance). */
const UTTERANCE_MAX = 600
/**
 * Silence around each utterance, in say's own markup: the audio output (Bluetooth above all) wakes for each new
 * stream and clipped the first syllable, and the next stream cut the last one.
 */
const LEAD_MS = 250
const TAIL_MS = 200
/** Kokoro starts an utterance only once it is synthesised: shorter batches start sooner. */
const KOKORO_UTTERANCE_MAX = 300
/** The words per minute Kokoro speaks at speed 1. */
const KOKORO_WPM = 190
/** A Kokoro voice's name: accent and sex, then the name ("af_heart", "bm_george"); a Mac voice has no underscore. */
const KOKORO_VOICE = /^[a-z]{2}_[a-z]+$/i
/** The director's and the narrator's limits: past them their answer is not waited for. */
const DIRECTOR_TIMEOUT_MS = 3000
const NARRATOR_TIMEOUT_MS = 4000
/** The synthesizer's limit: past it, the stretch's first sentence or so is said (gistOf). */
const SYNTH_TIMEOUT_MS = 8000
/** The most thinking or reply text summed up in one go: all that waits from one person's section, up to this. */
const SYNTH_BATCH_MAX = 1500
/** What the synthesizer and the narrator are shown of what was said lately, so nothing is said twice. */
const RECENT_KEPT = 6
/** Kokoro restarted by itself this many times a session at most, after its server died or kept failing. */
const KOKORO_RESTARTS_MAX = 2
/** Tables and code blocks narrated ahead of being said, at most: a reply of twelve snippets made twelve calls at once. */
const NARRATE_AHEAD = 2
/**
 * How long a /speak may take: the utterance before it plays out first (≈25 s for the longest, at the slowest rate),
 * then this one is synthesised. Past it the server is taken to be stuck and the line goes to say.
 */
const KOKORO_TIMEOUT_MS = 75_000
/** Kokoro is given up for the session after this many lines in a row it failed to play (one failure is a hiccup). */
const KOKORO_MISSES_MAX = 3
/** Where setup.sh puts the environment and the model (THINK_ALOUD_HOME overrides it). */
const ENGINE_HOME = '"${THINK_ALOUD_HOME:-$HOME/.claude/think-aloud}"'
/**
 * Stops the voice server an earlier load of this module started in this session, if it still runs: server.py
 * writes its pid to server.<its parent's pid>.pid, and a module reload (/reload-plugins) keeps the same parent.
 */
const STOP_PREDECESSOR = `p=$(cat ${ENGINE_HOME}/server.$PPID.pid 2>/dev/null) && ps -p "$p" -o command= 2>/dev/null | grep -q server.py && kill "$p"; exit 0`
const RATE_MIN = 120
const RATE_MAX = 400
/**
 * The keybinding action whose chord presses "next" (keybindings.json, e.g. `"alt+right": "diff:back"` in Chat).
 * Claude Code has no actions of a plugin's own yet, so this borrows one with no handler at the prompt: the diff
 * dialog's Back, which only acts while that dialog is open (and the binding lives in Chat, not there).
 */
const NEXT_ACTION = 'diff:back'
/** Whether a line is playing: the ⏭ row above the prompt shows only then. */
const SPEAKING = atom({ plugin: 'think-aloud', key: 'speaking' } as const, false)
/** The start of the reply text being spoken now ('' for none): the transcript block holding it is lit (owner, 23 Nov 2026). */
const LIT = atom({ plugin: 'think-aloud', key: 'lit' } as const, '')
/** The lit block's background: amber, as if translucent over a dark terminal. */
const LIT_COLOR = '#4b3e18'
const USAGE =
  '/speak on | off | stop | next | back | cast | cast <role> <voice> | name <role> <name> | actions on|off | intros on|off | classifier on|off | narrator on|off | thinking on|off | replies on|off | rate 200 | voice thinking|reply <name> | voices | engine kokoro|say | setup | live | all | test'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The module's speech state; a reload starts it over (the settings come back from the store). */
const S = {
  settings: { ...DEFAULTS, cast: defaultCast() } as Settings,
  interactive: true,
  team: new Team(DEFAULTS),
  running: false,
  child: null as AsyncGenerator<unknown, unknown> | null,
  /** The utterance heard now (from the moment it starts until the status line clears): what "next" skips. */
  current: null as Utterance | null,
  /** A `say` ended by "next": not a failure, so not said again in the system voice. */
  skippedChild: null as AsyncGenerator<unknown, unknown> | null,
  /** Bumped by every hush: a run of an earlier epoch stops at its next utterance. */
  epoch: 0,
  /** The director's call in flight, if any: one at a time, and a new prompt's replaces it. */
  directing: null as AbortController | null,
  /** The narrator's calls in flight, by the line they are for: a hush cuts them all, a dropped line its own. */
  narrating: new Map<Line, AbortController>(),
  /** Clears the status line once Kokoro's last utterance has played out. */
  statusTimer: null as { cancel: () => void } | null,
  /** The synthesizer this session (/speak shows it): stretches summed up, left unsaid as nothing new, or cut to a gist. */
  synth: { said: 0, silent: 0, gist: 0 },
  /** The last few utterances heard, newest last: the "said recently" of the synthesizer and the narrator, and what "back" replays. */
  played: [] as Utterance[],
  /** Taken off the queue by the run and not yet heard: "back" puts it back. */
  preparing: null as Line | null,
  /** The voices this Mac has (`say -v ?`), lowercased, full and short ("tara (english (india))", "tara"); null when unknown. */
  voices: null as Set<string> | null,
  /** The Kokoro engine in this session: its server's port once it is up. */
  kokoro: {
    state: 'idle' as 'idle' | 'setting-up' | 'starting' | 'ready' | 'failed',
    /** The voice server's process: leaving its loop (or return()) stops it. */
    server: null as AsyncGenerator<unknown, unknown> | null,
    port: null as number | null,
    /** Lines in a row it failed to play. */
    misses: 0,
    /** Restarts made by itself this session (KOKORO_RESTARTS_MAX). */
    restarts: 0,
    voices: [] as string[],
    /** The last line setup or the server wrote: what /speak shows when it failed. */
    note: '',
  },
}
S.team.settings = S.settings

/** The names `say -v ?` lists: "Rishi", "Eddy (English (UK))". */
function voiceNames(listing: string): string[] {
  return listing
    .split('\n')
    .map(l => l.replace(/\s+[a-z]{2,3}_[A-Za-z0-9]{2,4}\s+#.*$/, '').trim())
    .filter(Boolean)
}

/** A Mac voice by its full or short name ("Tara" for "Tara (English (India))"), as spelled in the listing. */
function macVoice(names: string[], wanted: string): string | undefined {
  const w = wanted.toLowerCase()
  for (const name of names) {
    const short = name.replace(/\s*\(.*$/, '')
    if (name.toLowerCase() === w) return name
    if (short.toLowerCase() === w) return short
  }
  return undefined
}

async function loadVoices($: EngineInterface): Promise<void> {
  try {
    const { exitCode, stdout } = await $.process.run(['say', '-v', '?'])
    if (exitCode !== 0) {
      S.voices = null
      return
    }
    const names = voiceNames(stdout)
    S.voices = new Set([...names, ...names.map(n => n.replace(/\s*\(.*$/, ''))].map(v => v.toLowerCase()))
  } catch {
    S.voices = null
  }
}

/** The settings as stored, over the defaults, field by field and of the right type: an older store still loads. */
async function load($: EngineInterface): Promise<void> {
  const kept = await $.store.get(STORE_KEY)
  const k = isRecord(kept) ? kept : {}
  const settings: Settings = { ...DEFAULTS, cast: mergeCast(k.cast) }
  const into = settings as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (key !== 'cast' && typeof k[key] === typeof value) into[key] = k[key]
  }
  // An uppercase "/speak Live" once stored pace "Live", which is neither.
  if (settings.pace !== 'live' && settings.pace !== 'all') settings.pace = DEFAULTS.pace
  if (settings.engine !== 'kokoro' && settings.engine !== 'say') settings.engine = DEFAULTS.engine
  S.settings = settings
  S.team.settings = settings
}

async function save($: EngineInterface): Promise<void> {
  await $.store.set(STORE_KEY, S.settings)
}

/** What was said lately, "Name: words": the synthesizer's and the narrator's "said recently". */
function recent(): string[] {
  return S.played.map(u => `${S.settings.cast[u.role].name}: ${u.text}`)
}

/** Nothing plays any more (`say`, Kokoro's playback and what it prepared); a run of the old epoch stops. */
function silence($: EngineInterface): void {
  S.epoch++
  const speaking = S.child
  S.child = null
  if (speaking) void speaking.return(undefined).catch(() => undefined)
  // The epoch goes along: this /stop and the next /speak can reach the server in either order (Neon review #7).
  if (S.kokoro.port !== null) {
    void $.http.fetch(`http://127.0.0.1:${S.kokoro.port}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ epoch: S.epoch }) }).catch(() => undefined)
  }
}

/** Everything said or waiting goes: the queue, the narrator's and the director's calls, `say`, Kokoro's playback. */
function hush($: EngineInterface): void {
  silence($)
  S.team.hush()
  S.preparing = null
  for (const stop of S.narrating.values()) stop.abort()
  S.narrating.clear()
  S.directing?.abort()
  S.directing = null
  idle($)
}

/**
 * "Back" (⌘←): the block before the one playing is said again, then that one from its start, then the rest as before.
 * What the next run had taken to prepare goes back too. The speaker's name, or undefined when nothing was said yet.
 */
function back($: EngineInterface): string | undefined {
  const now = S.current
  const before = now ? S.played[S.played.lastIndexOf(now) - 1] : S.played[S.played.length - 1]
  const again = [before, now].filter((u): u is Utterance => u !== undefined && u !== null)
  if (again.length === 0) return undefined
  silence($)
  S.played = S.played.filter(u => !again.includes(u))
  // Said as they were heard: a section of their own ("line:") keeps them from being summed up a second time.
  const lines: Line[] = again.map((u, i) => ({ role: u.role, kind: u.kind, text: u.text, section: `line:back:${S.epoch}:${i}` }))
  if (S.preparing) lines.push(S.preparing)
  S.preparing = null
  S.team.queue.unshift(...lines)
  play($)
  return S.settings.cast[again[0]!.role].name
}

/** Nothing is heard any more: the status line and the ⏭ row go. */
function idle($: EngineInterface): void {
  S.statusTimer?.cancel()
  S.statusTimer = null
  S.current = null
  $.ui.status(undefined)
  void update($, SPEAKING, () => false).catch(() => undefined)
  void update($, LIT, () => '').catch(() => undefined)
}

/**
 * "Next": the rest of what is being said goes (Team.skip: the whole thought, the reply's paragraph, table or code
 * block, or the action line, including what of it is still to stream in), and what follows plays at once. The
 * speaker's name, or undefined when nothing was playing.
 */
function next($: EngineInterface): string | undefined {
  const u = S.current
  if (!u?.section) return undefined
  S.team.skip(u.section)
  narrateAhead($)
  if (S.kokoro.port !== null) {
    void $.http.fetch(`http://127.0.0.1:${S.kokoro.port}/skip`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ section: u.section }) }).catch(() => undefined)
  }
  const child = S.child
  if (child) {
    S.skippedChild = child
    void child.return(undefined).catch(() => undefined)
  }
  // The last utterance (the run is over, its status waits for it to play out): nothing more is heard.
  if (!S.running) idle($)
  return S.settings.cast[u.role].name
}

/** What the team queued: the next blocks' narration is asked for, and speech starts if it is idle. */
function play($: EngineInterface): void {
  narrateAhead($)
  if (S.team.queue.length > 0 && !S.running) void work($)
}

/** Narration for the next NARRATE_AHEAD blocks waiting, not all at once; a block live pace dropped has its call cut. */
function narrateAhead($: EngineInterface): void {
  for (const [line, stop] of S.narrating) {
    if (!S.team.queue.includes(line)) {
      stop.abort()
      S.narrating.delete(line)
    }
  }
  let ahead = 0
  for (const line of S.team.queue) {
    if (!line.block) continue
    if (++ahead > NARRATE_AHEAD) break
    if (!line.pending) line.pending = narrate($, line)
  }
}

/** How to say a line's table or code block, by Haiku; the fallback when it is off, slow or fails. Never rejects. */
async function narrate($: EngineInterface, line: Line): Promise<string> {
  const block = line.block
  if (!block) return ''
  if (!S.settings.narrator) return fallbackNarration(block)
  const stop = new AbortController()
  S.narrating.set(line, stop)
  try {
    const r = await $.model.complete(
      { model: 'haiku', effort: 'low', maxTokens: 200, timeoutMs: NARRATOR_TIMEOUT_MS, prompt: narratorPrompt(block, recent()) },
      { signal: stop.signal },
    )
    if (r.isAnswered) return narrationOf(r.text, block)
    // An empty reply is the narrator choosing to skip; a timeout or an error is not.
    return r.reason === 'empty-reply' ? '' : fallbackNarration(block)
  } catch {
    return fallbackNarration(block)
  } finally {
    if (S.narrating.get(line) === stop) S.narrating.delete(line)
  }
}

/**
 * A stretch of thinking or reply summed up for the ear (Haiku, synthPrompt): only what is new and salient, with what
 * was said lately in view; '' when there is nothing new. When Haiku is slow or fails, its first sentence or so.
 * Never throws.
 */
async function synthesize($: EngineInterface, text: string, kind: 'thinking' | 'reply'): Promise<string> {
  if (!/[\p{L}\p{N}]/u.test(text)) return ''
  try {
    const r = await $.model.complete({ model: 'haiku', effort: 'low', maxTokens: 200, timeoutMs: SYNTH_TIMEOUT_MS, prompt: synthPrompt(text, kind, S.team.asked, recent()) })
    // An empty reply is the synthesizer choosing silence; a timeout or an error is not.
    if (r.isAnswered || r.reason === 'empty-reply') {
      const said = r.isAnswered ? synthOf(r.text) : ''
      S.synth[said ? 'said' : 'silent']++
      return said
    }
  } catch {
    // below: the gist
  }
  S.synth.gist++
  return gistOf(text)
}

/** Asks the director who speaks now, in the background; its answer stands from the next block on. Never throws. */
async function direct($: EngineInterface, why: 'prompt' | 'step'): Promise<void> {
  try {
    const now = await $.clock.now()
    if (!S.team.wantsDirector(now, why, S.directing !== null)) return
    // A new prompt makes an older question moot.
    S.directing?.abort()
    const stop = new AbortController()
    S.directing = stop
    try {
      const r = await $.model.complete(
        { model: 'haiku', effort: 'low', maxTokens: 300, timeoutMs: DIRECTOR_TIMEOUT_MS, prompt: S.team.ask(now) },
        { signal: stop.signal },
      )
      if (S.directing === stop && r.isAnswered) S.team.direct(r.text)
    } finally {
      if (S.directing === stop) S.directing = null
    }
  } catch {
    // no answer: the speaker and the board stay as they were
  }
}

/** The Kokoro voice for a role: theirs where the voices file has it, else the lead's, else Kokoro's best. */
function kokoroVoiceFor(role: Role): string {
  const known = S.kokoro.voices
  const mine = S.settings.cast[role].kokoro
  if (known.length === 0 || known.includes(mine)) return mine
  const lead = S.settings.cast.lead.kokoro
  return known.includes(lead) ? lead : 'af_heart'
}

/** The Mac voice for a role: theirs, else the next one the cast names, else (undefined) the system's own. */
function sayVoiceFor(role: Role): string | undefined {
  const mine = S.settings.cast[role].say
  if (S.voices === null) return mine
  for (const v of [mine, TEAM[role].sayElse]) if (v && S.voices.has(v.toLowerCase())) return v
  return undefined
}

/** An utterance is heard from now: the status line names its speaker, and their introduction counts as made. */
function shown($: EngineInterface, u: Utterance, source = ''): void {
  S.current = u
  S.preparing = null
  $.ui.status(u.status)
  S.team.spoke(u)
  S.played.push(u)
  if (S.played.length > RECENT_KEPT) S.played.shift()
  void update($, SPEAKING, () => true).catch(() => undefined)
  // The reply's words as written (not as summed up), so the block on screen that holds them can be found and lit.
  const lit = u.kind === 'reply' ? source.slice(0, 60) : ''
  void update($, LIT, () => lit).catch(() => undefined)
}

/** About how long an utterance plays, at `rate` words a minute. */
function playMs(text: string, rate: number): number {
  return Math.round((text.split(' ').length / rate) * 60_000) + 500
}

async function work($: EngineInterface): Promise<void> {
  S.running = true
  S.statusTimer?.cancel()
  S.statusTimer = null
  const mine = S.epoch
  const team = S.team
  /** The run failed, or stopped with lines left on purpose (Kokoro not up yet): no new run starts by itself. */
  let failed = false
  /** Kokoro's last utterance, still playing when this run ends: the status line stays up until it is over. */
  let playing = 0
  try {
    while (team.queue.length > 0 && mine === S.epoch) {
      const kokoro = S.settings.engine === 'kokoro'
      if (kokoro && S.kokoro.port === null) {
        // Kokoro only, never the Mac voice in its place (owner, 23 Nov 2026: the two once talked over each other):
        // what waits is said once the server is up (serveKokoro plays it), restarted here if it died.
        if (S.kokoro.state === 'idle' || (S.kokoro.state === 'failed' && S.kokoro.restarts++ < KOKORO_RESTARTS_MAX)) void startKokoro($)
        failed = true
        break
      }
      const head = team.queue[0]!
      /** A table or code block's narration: its words are chosen already, not summed up again. */
      let narrated = false
      if (head.block) {
        // A table or code block: its narration first, so what follows it is heard after it, as on screen.
        const said = await (head.pending ?? (head.pending = narrate($, head)))
        if (mine !== S.epoch) break
        team.settle(head, said)
        narrateAhead($)
        if (!said || team.queue[0] !== head) continue
        narrated = true
      }
      // Thinking and replies are summed up (Haiku), all that waits of one person's section at once; action lines and
      // /speak test are said as written. With the narrator off, everything is said as written.
      const synth = S.settings.narrator && !narrated && head.kind !== 'action' && !head.section?.startsWith('line:')
      const u = team.next(narrated ? 1 : synth ? SYNTH_BATCH_MAX : kokoro ? KOKORO_UTTERANCE_MAX : UTTERANCE_MAX)
      if (!u) break
      S.preparing = { role: u.role, kind: u.kind, text: u.text, ...(u.section ? { section: u.section } : {}) }
      // Summed up while the utterance before it still plays; skipped meanwhile, or nothing new, it is not said.
      const said = synth ? await synthesize($, u.text, u.kind === 'reply' ? 'reply' : 'thinking') : u.text
      if (mine !== S.epoch) continue
      if ((u.section !== undefined && team.isSkipped(u.section)) || !said) {
        S.preparing = null
        continue
      }
      const source = narrated ? '' : u.text
      u.text = u.intro ? `${u.intro} ${said}` : said
      const rate = Math.round(u.kind === 'reply' ? S.settings.rate : S.settings.rate * THINKING_FASTER)
      playing = 0
      if (kokoro) {
        // One retry: a failed line is tried again, then left unsaid; a server that keeps failing is restarted.
        let r = await kokoroSpeak($, u.text, kokoroVoiceFor(u.role), rate / KOKORO_WPM, mine, u.section)
        if (r === 'failed' && mine === S.epoch) r = await kokoroSpeak($, u.text, kokoroVoiceFor(u.role), rate / KOKORO_WPM, mine, u.section)
        if (r === 'started') {
          // Kokoro answers as this utterance begins (the one before it has just ended): it is heard from now.
          S.kokoro.misses = 0
          shown($, u, source)
          playing = playMs(u.text, rate)
        } else if (r === 'failed' && mine === S.epoch && ++S.kokoro.misses >= KOKORO_MISSES_MAX) {
          stopKokoro('failed', 'the voice server stopped playing')
        }
        continue
      }
      shown($, u, source)
      await sayLine($, u, rate, mine)
    }
  } catch {
    // Nothing here may reach the engine; what is left waits for the next line queued (no retry loop).
    failed = true
  } finally {
    S.running = false
    try {
      if (mine === S.epoch && playing > 0 && !failed) S.statusTimer = $.clock.after(playing, () => S.running || idle($))
      else if (mine === S.epoch) idle($)
    } catch {
      // the status line stays as it was
    }
    // Lines queued after a hush, while this run was still finishing, start a run of their own.
    if (!failed && team.queue.length > 0) void work($)
  }
}

/** One utterance by `say`, in the speaker's Mac voice; once more in the Mac's default voice if that one fails. */
async function sayLine($: EngineInterface, u: Utterance, rate: number, epoch: number): Promise<void> {
  const voice = sayVoiceFor(u.role)
  for (const argv of voice ? [['-v', voice], []] : [[]]) {
    if (epoch !== S.epoch) return
    const say = $.process.spawn({ argv: ['say', ...argv, '-r', String(rate)], input: `[[slnc ${LEAD_MS}]] ${u.text} [[slnc ${TAIL_MS}]]` })
    S.child = say
    let code: number | null = null
    try {
      for await (const _ of say) {
        // say writes nothing; the loop is its life, so a hush (return) ends it.
      }
      code = (await say.result).code
    } catch {
      // killed by a hush, or it could not start
    }
    if (S.child === say) S.child = null
    if (S.skippedChild === say) {
      S.skippedChild = null
      return
    }
    if (code === 0 || epoch !== S.epoch) return
  }
}

/**
 * One utterance to the Kokoro server: 'started' as it begins playing, 'stopped' when a hush overtook it, 'failed'
 * when the server did not play it (gone, stalled past KOKORO_TIMEOUT_MS, or its audio output failed).
 */
async function kokoroSpeak($: EngineInterface, text: string, voice: string, speed: number, epoch: number, section?: string): Promise<'started' | 'stopped' | 'failed'> {
  // $.http.fetch takes no timeout: a sleep races it (a stuck server held speech up for good: Neon review #1).
  const timer = new AbortController()
  try {
    const res = await Promise.race([
      $.http.fetch(`http://127.0.0.1:${S.kokoro.port}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, speed, epoch, section }),
      }),
      // A sleep cut short for any other reason leaves the fetch to decide, as before the timeout.
      $.clock.sleep(KOKORO_TIMEOUT_MS, { signal: timer.signal }).then(
        () => null,
        () => new Promise<never>(() => undefined),
      ),
    ])
    if (!res?.ok) return 'failed'
    const answer = JSON.parse(res.text) as { started?: boolean; stopped?: boolean }
    return answer.started ? 'started' : answer.stopped ? 'stopped' : 'failed'
  } catch {
    return 'failed'
  } finally {
    timer.abort()
  }
}

/** Stops the voice server (its loop ends, and with it the process); a setup under way carries on. */
function stopKokoro(state: 'idle' | 'failed', note?: string): void {
  const server = S.kokoro.server
  S.kokoro.server = null
  S.kokoro.port = null
  S.kokoro.misses = 0
  if (S.kokoro.state !== 'setting-up') S.kokoro.state = state
  if (note) S.kokoro.note = note
  if (server) void server.return(undefined).catch(() => undefined)
}

/**
 * The Kokoro engine for this session: setup.sh first where it has not finished on this Mac (in the background, its
 * steps in the status line), then the voice server. Never awaited by session.start: speech waits for it.
 * `repair` (/speak setup): the server stops, and setup.sh runs with --repair even where ready-v1 says it is done,
 * so a broken install (a Python upgrade, a lost model file) can be fixed from inside a session (Neon review #5).
 */
async function startKokoro($: EngineInterface, repair = false): Promise<void> {
  try {
    if (S.kokoro.state === 'setting-up') return
    if (!repair && (S.kokoro.state === 'starting' || S.kokoro.state === 'ready')) return
    if (repair) stopKokoro('idle')
    const ready = !repair && (await $.process.run(['/bin/sh', '-c', `test -f ${ENGINE_HOME}/ready-v1`]).then(r => r.exitCode === 0, () => false))
    if (!ready) {
      S.kokoro.state = 'setting-up'
      $.ui.toast(
        repair
          ? 'think-aloud: checking the Kokoro voice and rebuilding what is broken. Speech resumes when it is ready.'
          : 'think-aloud: setting up the Kokoro voice, one time (about 350 MB). Speech starts when it is ready.',
      )
      const setup = $.process.spawn({ argv: ['/bin/bash', `${$.plugin.root}/engine/setup.sh`, ...(repair ? ['--repair'] : [])] })
      for await (const { text } of setup) {
        const line = text.trim().split('\n').pop() ?? ''
        if (line) {
          S.kokoro.note = line
          if (line.startsWith('think-aloud:')) $.ui.status(`🔊 ${line.replace(/^think-aloud:\s*/, 'Kokoro: ')}`)
        }
      }
      const { code } = await setup.result
      $.ui.status(undefined)
      if (code !== 0) {
        S.kokoro.state = 'failed'
        $.ui.toast(`think-aloud: the Kokoro voice could not be set up (${S.kokoro.note || `exit ${code}`}). Silent until then; /speak setup tries again, /speak engine say uses the Mac voice.`)
        return
      }
      $.ui.toast('think-aloud: the Kokoro voice is ready.')
    }
    // Switched off, or to the Mac voice, while it was set up: no server.
    if (!S.settings.on || S.settings.engine !== 'kokoro') {
      S.kokoro.state = 'idle'
      return
    }
    S.kokoro.state = 'starting'
    void serveKokoro($)
  } catch {
    S.kokoro.state = 'failed'
    try {
      $.ui.status(undefined)
    } catch {
      // nothing to do
    }
  }
}

/** The voice server, for as long as it runs: its port once the model is loaded, then say again if it ends. */
async function serveKokoro($: EngineInterface): Promise<void> {
  let server: AsyncGenerator<{ stream: string; text: string }, unknown> | null = null
  try {
    // One server per session: a reloaded module's predecessor goes first.
    await $.process.run(['/bin/sh', '-c', STOP_PREDECESSOR]).catch(() => undefined)
    if (S.kokoro.state !== 'starting' || S.kokoro.server !== null) return
    const spawned = $.process.spawn({
      argv: ['/bin/sh', '-c', `exec ${ENGINE_HOME}/venv/bin/python "$0"`, `${$.plugin.root}/engine/server.py`],
    })
    server = spawned
    S.kokoro.server = spawned
    for await (const { stream, text } of spawned) {
      // Stopped (/speak off, engine say, setup, too many failures): leaving the loop ends the process.
      if (S.kokoro.server !== spawned) break
      const port = /PORT (\d+)/.exec(text)
      if (port) {
        S.kokoro.port = Number(port[1])
        S.kokoro.state = 'ready'
        const health = await $.http.fetch(`http://127.0.0.1:${S.kokoro.port}/health`).catch(() => null)
        try {
          S.kokoro.voices = health?.ok ? ((JSON.parse(health.text) as { voices?: string[] }).voices ?? []) : []
        } catch {
          S.kokoro.voices = []
        }
        // What waited for the voice is said now.
        play($)
      } else if (stream === 'stderr') {
        const line = text.trim().split('\n').pop()
        if (line) S.kokoro.note = line
      }
    }
  } catch {
    // the server could not start or was killed
  }
  // It ended by itself (stopped on purpose, stopKokoro has already said what comes next).
  if (server !== null && S.kokoro.server === server) {
    S.kokoro.server = null
    S.kokoro.port = null
    S.kokoro.state = 'failed'
  } else if (server === null && S.kokoro.state === 'starting') S.kokoro.state = 'failed'
}

/** Gives a role a voice: a Kokoro name ("bf_emma") or a Mac one ("Moira"); why not, when it cannot. */
async function setVoice($: EngineInterface, role: Role, voice: string): Promise<string | undefined> {
  const person = S.settings.cast[role]
  if (KOKORO_VOICE.test(voice)) {
    const known = S.kokoro.voices
    const k = known.length > 0 ? known.find(v => v.toLowerCase() === voice.toLowerCase()) : voice.toLowerCase()
    if (!k) return `No Kokoro voice "${voice}". /speak voices lists them.`
    person.kokoro = k
    return undefined
  }
  const { stdout } = await $.process.run(['say', '-v', '?'])
  const match = macVoice(voiceNames(stdout), voice)
  if (!match) return `No voice "${voice}" on this Mac. /speak voices lists the English ones.`
  person.say = match
  return undefined
}

function onOff(v: boolean): string {
  return v ? 'on' : 'off'
}

/** Who speaks now, in a line. */
function teamNow(): string {
  const c = S.settings.cast
  const thinking = S.settings.director ? `the team (${WORKERS.map(r => c[r].name).join(', ')})` : c.planner.name
  const who = [S.settings.replies ? `replies by ${c.lead.name}` : null, S.settings.thinking ? `thinking by ${thinking}` : null].filter(Boolean).join(', ') || 'nothing selected'
  return `${who}; actions ${onOff(S.settings.actions)}, intros ${onOff(S.settings.intros)}, director ${onOff(S.settings.director)}, narrator ${onOff(S.settings.narrator)}`
}

/** The team, one person a line, and the board: what `/speak cast` prints. */
function castNow(): string {
  const c = S.settings.cast
  const rows = ROLES.map(r => `${c[r].name} · ${r} · Kokoro ${c[r].kokoro}, Mac ${sayVoiceFor(r) ?? 'system voice'} · ${TEAM[r].owns}`)
  const now = S.settings.director
    ? `Speaking the work now: ${c[S.team.speaker].name} (${S.team.speaker}). Board: ${boardText(S.team.board, c)}.`
    : `The director is off: ${c.planner.name} speaks all the thinking.`
  return `The team:\n${rows.join('\n')}\n\n${now}\n/speak cast <role> <voice> · /speak name <role> <name> · /speak voices`
}

function engineNow(): string {
  if (S.settings.engine === 'say') return 'Engine: the Mac voice (/speak engine kokoro for the natural one).'
  switch (S.kokoro.state) {
    case 'ready':
      return 'Engine: Kokoro.'
    case 'setting-up':
      return `Engine: Kokoro is being set up (${S.kokoro.note || 'starting'}); speech starts when it is ready.`
    case 'starting':
      return 'Engine: Kokoro is loading; speech starts when it is ready.'
    case 'failed':
      return `Engine: Kokoro is not running (${S.kokoro.note || 'unknown'}); silent until it is back. /speak setup tries again.`
    default:
      return 'Engine: Kokoro starts with the next session (/speak setup now).'
  }
}

export const register: Register = on => {
  // Also after a reload of this module (session.start fires again): a server of the old one is stopped first.
  on('session.start', async ($, e, next) => {
    try {
      S.interactive = e.isInteractive !== false
      await load($)
      S.team.reset()
      S.played = []
      // In the background, and only where it will speak: `say -v ?` held every session's start up.
      if (S.interactive && S.settings.on) {
        void loadVoices($)
        if (S.settings.engine === 'kokoro') void startKokoro($)
      }
    } catch {
      // the defaults stand
    }
    try {
      await $.command.register({
        name: 'speak',
        description: `Hear Claude think and reply aloud, as a small team of voices: ${USAGE}`,
      })
    } catch {
      // no /speak this session; speech still works
    }
    try {
      // What the keybindings run (keybindings.json, Chat: "cmd+right": "command:speak-next", "cmd+left": "command:speak-back"); silent, no output row.
      await $.command.register({ name: 'speak-next', description: 'think-aloud: skip to the next block (bind a key to command:speak-next)' })
      await $.command.register({ name: 'speak-back', description: 'think-aloud: back to the block before (bind a key to command:speak-back)' })
    } catch {
      // no shortcut command this session; /speak next still works
    }
    return next(e)
  })

  on('command.run', { command: 'speak-next' }, async $ => {
    next($)
    return {}
  })

  on('command.run', { command: 'speak-back' }, async $ => {
    back($)
    return {}
  })

  // The user's prompt: the director's first look at the turn, in the background.
  on('turn.start', async ($, e, next) => {
    try {
      if (S.settings.on && S.interactive && e.agentId === undefined && e.text.trim()) {
        S.team.begin(e.text)
        void direct($, 'prompt')
      }
    } catch {
      // nothing to do: the speaker stays as it was
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!S.settings.on || !S.interactive || e.agentId !== undefined) return yield* next(e)
    // Speech for this step stops with a hush (Esc, a new message, /speak stop): nothing is flushed after it.
    const epoch = S.epoch
    // After tool results: the director sees what was done (at most one call in flight, a few seconds apart).
    if (e.index > 0) void direct($, 'step')
    const reader = new StepReader(`${e.turnId}:${e.index}`, S.team)
    // Read by hand, not with for-await, so the step's result goes up as it came (Neon review #2).
    const stream = next(e)
    let finished = false
    try {
      for (;;) {
        const step = await stream.next()
        if (step.done) {
          finished = true
          // The stream is over: the last block's tail (a final sentence with no newline after it) is said too.
          try {
            if (epoch === S.epoch) {
              reader.end()
              play($)
            }
          } catch {
            // nothing to do
          }
          return step.value
        }
        yield step.value
        // Speech never breaks the stream: whatever goes wrong here stays here.
        try {
          if (epoch === S.epoch) {
            reader.chunk(step.value)
            play($)
          }
        } catch {
          // nothing to do: the next sentence tries again
        }
      }
    } finally {
      // Left before the end (whoever reads this stream stopped): the stream beneath is closed too.
      if (!finished) await stream.return(undefined as never).catch(() => undefined)
    }
  })

  // A new message, or Esc: what is still being said is old news.
  // A new message does not cut speech off (owner, 23 Nov 2026: "be in sync with Claude, as live mode is"): what is
  // being said finishes, the old turn's thinking and action lines still waiting go, its reply's lines stay. Esc still
  // stops it all (turn.complete, aborted).
  on('prompt.submit', async ($, e, next) => {
    try {
      if (!e.turnId) trimBacklog(S.team.queue, 0, 0)
    } catch {
      // nothing to do
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The reply block being spoken is lit in the transcript, amber over its rows, while it plays.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next_) => {
    const lit = S.settings.on ? await read($, LIT) : ''
    const drawn = await next_(e)
    if (!lit || e.props.onScreen === null || !e.props.text.split('\n').map(spoken).join(' ').includes(lit)) return drawn
    const { Box } = $.ui.resolve(e)
    return h(Box, { flexDirection: 'column', backgroundColor: LIT_COLOR }, drawn) as RenderElement
  })

  on('turn.complete', async ($, e, next) => {
    try {
      if (e.reason === 'aborted' && !('agentId' in e && e.agentId)) hush($)
    } catch {
      // nothing to do
    }
    return next(e)
  })

  // While a line plays: a ⏭ above the prompt, pressed by a click or by the chord bound to NEXT_ACTION.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next_) => {
    if (e.props.hasSurvey || !S.settings.on || !(await read($, SPEAKING))) return next_(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    // h() is what JSX compiles to; a Box always makes an element.
    return h(
      Box,
      null,
      h(Button, { key: 'think-aloud-next', label: '⏭ next', action: NEXT_ACTION, plain: true, onPress: () => void next($) }),
      h(Text, { dimColor: true }, '  ⌘← back · ⌘→ next block'),
    ) as RenderElement
  })

  on('command.run', { command: 'speak' }, async ($, e) => {
    const [raw = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    // "/speak Live" and "/speak Thinking off" are the same commands (they wrote settings named "Live", "Thinking").
    const word = raw.toLowerCase()
    const arg = rest.join(' ')
    const flag = (v: string) => (v.toLowerCase() === 'on' ? true : v.toLowerCase() === 'off' ? false : undefined)
    const c = S.settings.cast
    let note = ''
    switch (word) {
      case '':
      case 'status':
        break
      case 'on':
        S.settings.on = true
        if (S.interactive) {
          if (S.voices === null) void loadVoices($)
          if (S.settings.engine === 'kokoro') void startKokoro($)
        }
        note = 'Speaking from the next response.'
        break
      case 'off':
        S.settings.on = false
        hush($)
        stopKokoro('idle')
        note = 'Quiet.'
        break
      case 'stop':
        hush($)
        return { text: 'Stopped what was being said; still on for the next response.' }
      case 'back':
      case 'previous': {
        const who = back($)
        return { text: who ? `Back to ${who}'s block before.` : 'Nothing has been said yet.' }
      }
      case 'next':
      case 'skip': {
        const who = next($)
        return { text: who ? `Skipped the rest of ${who}'s block.` : 'Nothing is being said.' }
      }
      case 'thinking':
      case 'replies':
      case 'actions':
      case 'intros':
      case 'narrator':
      case 'classifier':
      case 'director': {
        const v = flag(arg)
        if (v === undefined) return { text: `Use /speak ${word} on, or /speak ${word} off.` }
        const key = word === 'classifier' ? 'director' : (word as 'thinking' | 'replies' | 'actions' | 'intros' | 'narrator' | 'director')
        S.settings[key] = v
        break
      }
      case 'cast': {
        if (rest.length === 0) return { text: castNow() }
        const [who = '', ...name] = rest
        const role = roleOf(who, c)
        const voice = name.join(' ')
        if (!role || !voice) return { text: `Use /speak cast <role> <voice>, a role being one of ${ROLES.join(', ')} (/speak voices lists the voices).` }
        const why = await setVoice($, role, voice)
        if (why) return { text: why }
        note = `${c[role].name} (${role}) now speaks in ${voice}.`
        break
      }
      case 'name': {
        const [who = '', ...name] = rest
        const role = roleOf(who, c)
        const called = name.join(' ').trim()
        if (!role || !/^[\p{L}][\p{L} '-]{0,19}$/u.test(called)) return { text: `Use /speak name <role> <name>, a role being one of ${ROLES.join(', ')}, a name up to 20 letters.` }
        note = `${c[role].name} (${role}) is now ${called}.`
        c[role].name = called
        break
      }
      case 'rate': {
        const n = Number(arg)
        if (!Number.isFinite(n) || n < RATE_MIN || n > RATE_MAX) return { text: `Rate is words per minute, ${RATE_MIN} to ${RATE_MAX} (now ${S.settings.rate}).` }
        S.settings.rate = Math.round(n)
        break
      }
      case 'voice': {
        // From before the team: the reply's voice is the lead's, the thinking's the planner's.
        const [which = '', ...name] = rest
        const voice = name.join(' ')
        if ((which !== 'thinking' && which !== 'reply') || !voice) return { text: 'Use /speak voice thinking <name> or /speak voice reply <name> (/speak voices lists them; /speak cast <role> <voice> sets anyone).' }
        const why = await setVoice($, which === 'reply' ? 'lead' : 'planner', voice)
        if (why) return { text: why }
        break
      }
      case 'voices': {
        if (S.settings.engine === 'kokoro' && S.kokoro.voices.length > 0) {
          return { text: `Kokoro voices (af/am American, bf/bm British; f female, m male; af_heart is the best rated):\n${S.kokoro.voices.filter(v => /^[ab][fm]_/.test(v)).join(', ')}\n\n/speak cast <role> <voice> gives one to a member of the team.` }
        }
        const { stdout } = await $.process.run(['say', '-v', '?'])
        const english = stdout
          .split('\n')
          .filter(l => /\ben_(IN|US|GB|AU|IE|ZA)\b/.test(l))
          .map(l => l.replace(/\s+#.*$/, '').replace(/\s{2,}/g, '  ').trim())
        return { text: `English voices on this Mac:\n${english.join('\n')}\n\nMore (Premium / Enhanced) in System Settings › Accessibility › Spoken Content › System voice › Manage Voices. /speak cast <role> <voice> gives one to a member of the team.` }
      }
      case 'engine': {
        const engine = arg.toLowerCase()
        if (engine !== 'kokoro' && engine !== 'say') return { text: 'Use /speak engine kokoro (the natural voice, set up by itself) or /speak engine say (the Mac voice).' }
        S.settings.engine = engine
        if (engine === 'kokoro') void startKokoro($)
        else stopKokoro('idle')
        break
      }
      case 'setup':
        if (S.kokoro.state === 'setting-up') return { text: 'The Kokoro voice is being set up already; the status line shows its steps.' }
        S.settings.engine = 'kokoro'
        void startKokoro($, true)
        note = 'Checking the Kokoro voice and rebuilding what is broken, in the background; the status line shows its steps.'
        break
      case 'live':
      case 'all':
        S.settings.pace = word
        break
      case 'test':
        S.team.line('planner', 'thinking', 'This is how my thinking sounds.')
        S.team.line('lead', 'reply', 'And this is how my replies sound.')
        play($)
        return { text: `Playing a sample: ${c.planner.name} thinking, then ${c.lead.name} replying (/speak cast for the whole team).` }
      default:
        return { text: `Unknown. ${USAGE}` }
    }
    await save($)
    return {
      text: `${note ? `${note} ` : ''}think-aloud is ${onOff(S.settings.on)}: ${teamNow()}; ${S.settings.rate} words a minute, ${S.settings.pace} pace. ${engineNow()} Synthesizer: ${S.synth.said} said, ${S.synth.silent} left unsaid (nothing new), ${S.synth.gist} cut to a gist (Haiku slow or failed).${S.interactive ? '' : ' (Not in this non-interactive session.)'}`,
    }
  })
}
