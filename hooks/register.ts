import type { EngineInterface, Register } from 'claude-code'

/**
 * think-aloud: Claude's thinking and replies, spoken as they stream, by the Mac's own `say` (free, offline).
 *
 * A `turn.step` hook reads the main loop's response as it arrives (subagents stay quiet), cuts it into sentences
 * the moment each one ends, cleans the markdown so it sounds like speech (no code blocks, no table rules, a path
 * as its file name, a link as "a link"), and queues them for `say`, one at a time: thinking in one voice, the
 * reply in another. Nothing in the stream is changed or slowed: every chunk passes on before it is read.
 *
 * In `live` pace (the default) speech keeps up with the model: when more than BACKLOG_MAX sentences wait, the
 * oldest thinking ones are skipped (the reply's never are). Sending a message, pressing Esc, or `/speak stop`
 * silences it at once. `/speak` shows and changes the settings, kept across sessions.
 */

/** What `/speak` changes ($.store, across sessions). */
export type Settings = {
  on: boolean
  thinking: boolean
  replies: boolean
  thinkingVoice: string
  replyVoice: string
  /** The reply's words per minute; thinking runs THINKING_FASTER of it. */
  rate: number
  /** live: skip stale thinking to keep up with the model; all: speak every sentence, however far behind. */
  pace: 'live' | 'all'
}

export const DEFAULTS: Settings = {
  on: true,
  thinking: true,
  replies: true,
  thinkingVoice: 'Rishi',
  replyVoice: 'Samantha',
  rate: 200,
  pace: 'live',
}

const STORE_KEY = 'settings'
/** Live pace: when more sentences than this wait, the oldest thinking ones go, down to BACKLOG_KEEP waiting. */
const BACKLOG_MAX = 6
const BACKLOG_KEEP = 2
const THINKING_FASTER = 1.15
/** A piece shorter than this ("e.g.", "OK.") joins the next one. */
const MIN_SENTENCE = 12
/** Sentences already waiting are said together up to this many characters (one natural utterance). */
const UTTERANCE_MAX = 600
/**
 * Silence around each utterance, in say's own markup: the audio output (Bluetooth above all) wakes for each new
 * stream and clipped the first syllable, and the next stream cut the last one.
 */
const LEAD_MS = 250
const TAIL_MS = 200
const RATE_MIN = 120
const RATE_MAX = 400

type Kind = 'thinking' | 'reply'

/** A path's last part ("research/notes/HANDOVER.md" → "HANDOVER.md"); a fraction or a split ("20/40/40", "A/B/C") stays. */
function shortPath(token: string): string {
  const parts = token.split('/').filter(Boolean)
  const isPath = parts.length > 1 && parts.some(p => p.length >= 4 && /[A-Za-z]/.test(p))
  return isPath ? (parts[parts.length - 1] ?? token) : token
}

/** One line of markdown as it should sound; '' for nothing (a table rule, a horizontal rule, an empty line). */
export function spoken(line: string): string {
  let s = line.trim()
  if (!s) return ''
  if (/^[\s|:+-]+$/.test(s) && s.includes('-')) return ''
  if (s.startsWith('|')) s = s.split('|').map(cell => cell.trim()).filter(Boolean).join(', ')
  s = s
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^([-*+•]|\d+[.)])\s+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[~\w.-]*\/[\w./-]*/g, shortPath)
    .replace(/~(?=\d)/g, 'about ')
    .replace(/\s*(→|->|⇒)\s*/g, ' to ')
    .replace(/≥/g, ' at least ')
    .replace(/≤/g, ' at most ')
    .replace(/×/g, ' times ')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\[\[|\]\]/g, ' ')
    .replace(/[`*~]+/g, '')
    .replace(/(\w)_(?=\w)/g, '$1 ')
    .replace(/\s+/g, ' ')
    .trim()
  return /[\p{L}\p{N}]/u.test(s) ? s : ''
}

/**
 * One content block's text as it streams, out as spoken sentences the moment each ends: a finished line always,
 * and within a line, up to its last sentence end. Fenced code is skipped whole.
 */
export class Sentences {
  private text = ''
  private inCode = false
  private pending = ''

  /** A piece of the block; the sentences it completed. */
  push(piece: string): string[] {
    this.text += piece
    return this.drain(false)
  }

  /** The block is over: what is left. */
  end(): string[] {
    return this.drain(true)
  }

  private drain(final: boolean): string[] {
    const out: string[] = []
    let nl = this.text.indexOf('\n')
    while (nl >= 0) {
      this.line(this.text.slice(0, nl), out)
      this.text = this.text.slice(nl + 1)
      nl = this.text.indexOf('\n')
    }
    if (final) {
      if (this.text) this.line(this.text, out)
      this.text = ''
      if (this.pending) out.push(this.pending)
      this.pending = ''
    } else if (!this.inCode && !/^\s*(```|\|)/.test(this.text)) {
      // Within a line: up to its last sentence end, so a long paragraph is heard as it is written.
      const ends = [...this.text.matchAll(/[.!?](?=\s)/g)]
      const last = ends[ends.length - 1]
      if (last?.index !== undefined) {
        this.add(spoken(this.text.slice(0, last.index + 1)), out)
        this.text = this.text.slice(last.index + 1)
      }
    }
    return out
  }

  private line(raw: string, out: string[]): void {
    if (raw.trim().startsWith('```')) {
      this.inCode = !this.inCode
      return
    }
    if (!this.inCode) this.add(spoken(raw), out)
  }

  private add(clean: string, out: string[]): void {
    // A sentence ends at . ! or ? followed by a space or the end: "2.0.7", "e.g.x" and "HANDOVER.md" stay whole.
    const pieces: string[] = []
    let from = 0
    for (const m of clean.matchAll(/[.!?]+["')\]]*(?=\s|$)/g)) {
      const to = (m.index ?? 0) + m[0].length
      pieces.push(clean.slice(from, to))
      from = to
    }
    pieces.push(clean.slice(from))
    for (const piece of pieces) {
      const s = piece.trim()
      if (!s) continue
      const joined = this.pending ? `${this.pending} ${s}` : s
      if (joined.length < MIN_SENTENCE) {
        this.pending = joined
        continue
      }
      out.push(joined)
      this.pending = ''
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** The module's speech state; a reload starts it over (the settings come back from the store). */
const S = {
  settings: { ...DEFAULTS } as Settings,
  interactive: true,
  queue: [] as { kind: Kind; text: string }[],
  blocks: new Map<string, Sentences>(),
  child: null as AsyncGenerator<unknown, unknown> | null,
  running: false,
  /** Bumped by every hush: a run of an earlier epoch stops at its next sentence. */
  epoch: 0,
  /** The voices this Mac has (`say -v ?`), lowercased; null when they could not be listed (then the name is tried). */
  voices: null as Set<string> | null,
}

/** The names `say -v ?` lists: "Rishi", "Eddy (English (UK))". */
function voiceNames(listing: string): string[] {
  return listing
    .split('\n')
    .map(l => l.replace(/\s+[a-z]{2,3}_[A-Za-z0-9]{2,4}\s+#.*$/, '').trim())
    .filter(Boolean)
}

async function loadVoices($: EngineInterface): Promise<void> {
  try {
    const { exitCode, stdout } = await $.process.run(['say', '-v', '?'])
    S.voices = exitCode === 0 ? new Set(voiceNames(stdout).map(v => v.toLowerCase())) : null
  } catch {
    S.voices = null
  }
}

async function load($: EngineInterface): Promise<void> {
  const kept = await $.store.get(STORE_KEY)
  S.settings = { ...DEFAULTS, ...(isRecord(kept) ? (kept as Partial<Settings>) : {}) }
}

async function save($: EngineInterface): Promise<void> {
  await $.store.set(STORE_KEY, S.settings)
}

function hush($: EngineInterface): void {
  S.epoch++
  S.queue.length = 0
  S.blocks.clear()
  const speaking = S.child
  S.child = null
  if (speaking) void speaking.return(undefined).catch(() => undefined)
  $.ui.status(undefined)
}

function enqueue($: EngineInterface, kind: Kind, sentences: string[]): void {
  if (sentences.length === 0) return
  for (const text of sentences) S.queue.push({ kind, text })
  if (S.settings.pace === 'live' && S.queue.length > BACKLOG_MAX) {
    let excess = S.queue.length - BACKLOG_KEEP
    for (let i = 0; i < S.queue.length && excess > 0; ) {
      if (S.queue[i]?.kind === 'thinking') {
        S.queue.splice(i, 1)
        excess--
      } else i++
    }
  }
  if (!S.running) void work($)
}

async function work($: EngineInterface): Promise<void> {
  S.running = true
  const mine = S.epoch
  try {
    while (S.queue.length > 0 && mine === S.epoch) {
      // Everything already waiting of the same kind, as one utterance: one say per line ended each line with a
      // closing intonation and a gap, which sounded cut off mid-thought.
      const line = { ...S.queue.shift()! }
      while (S.queue[0]?.kind === line.kind && line.text.length + S.queue[0].text.length < UTTERANCE_MAX) {
        line.text += ` ${S.queue.shift()!.text}`
      }
      const thinking = line.kind === 'thinking'
      const voice = thinking ? S.settings.thinkingVoice : S.settings.replyVoice
      const rate = Math.round(thinking ? S.settings.rate * THINKING_FASTER : S.settings.rate)
      $.ui.status(thinking ? '🔊 thinking' : '🔊 reply')
      // A voice this Mac does not have: its default voice, rather than silence.
      const withVoice = S.voices === null || S.voices.has(voice.toLowerCase()) ? ['-v', voice] : []
      const say = $.process.spawn({ argv: ['say', ...withVoice, '-r', String(rate)], input: `[[slnc ${LEAD_MS}]] ${line.text} [[slnc ${TAIL_MS}]]` })
      S.child = say
      try {
        for await (const _ of say) {
          // say writes nothing; the loop is its life, so a hush (return) ends it.
        }
      } catch {
        // Killed by a hush, or the voice is missing: on to the next sentence.
      }
      if (S.child === say) S.child = null
    }
  } finally {
    S.running = false
    if (mine === S.epoch) $.ui.status(undefined)
    if (S.queue.length > 0) void work($)
  }
}

/** Feeds a block's piece; ends the block before it in this step when a new one starts. */
function feed($: EngineInterface, step: string, kind: Kind, index: number, text: string, last: { key?: string; kind?: Kind }): void {
  const key = `${step}:${index}`
  if (last.key !== undefined && last.key !== key) finish($, last.key, last.kind!)
  last.key = key
  last.kind = kind
  let block = S.blocks.get(key)
  if (!block) S.blocks.set(key, (block = new Sentences()))
  enqueue($, kind, block.push(text))
}

function finish($: EngineInterface, key: string, kind: Kind): void {
  const block = S.blocks.get(key)
  if (!block) return
  S.blocks.delete(key)
  enqueue($, kind, block.end())
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    S.interactive = e.isInteractive !== false
    await load($)
    await loadVoices($)
    await $.command.register({
      name: 'speak',
      description: "Hear Claude think and reply aloud: /speak on | off | stop | thinking on|off | replies on|off | rate 200 | voice thinking|reply <name> | voices | live | all | test",
    })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (!S.settings.on || !S.interactive || e.agentId !== undefined) return yield* next(e)
    const step = `${e.turnId}:${e.index}`
    const last: { key?: string; kind?: Kind } = {}
    for await (const chunk of next(e)) {
      yield chunk
      // Speech never breaks the stream: whatever goes wrong here stays here.
      try {
        if (chunk.kind === 'thinking' && S.settings.thinking) feed($, step, 'thinking', chunk.index, chunk.text, last)
        else if (chunk.kind === 'text' && S.settings.replies) feed($, step, 'reply', chunk.index, chunk.text, last)
        else if (chunk.kind === 'tool' || chunk.kind === 'stop') {
          if (last.key !== undefined) finish($, last.key, last.kind!)
          last.key = undefined
        }
      } catch {
        // nothing to do: the next sentence tries again
      }
    }
    // The stream is over: the last block's tail (a final sentence with no newline after it) is said too.
    try {
      if (last.key !== undefined) finish($, last.key, last.kind!)
    } catch {
      // nothing to do
    }
  })

  // A new message, or Esc: what is still being said is old news.
  on('prompt.submit', async ($, e, next) => {
    // Never in the prompt's way: a failure here only leaves the old speech playing.
    try {
      hush($)
    } catch {
      // nothing to do
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.reason === 'aborted' && !('agentId' in e && e.agentId)) hush($)
    return next(e)
  })

  on('command.run', { command: 'speak' }, async ($, e) => {
    const [word = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')
    const flag = (v: string) => (v === 'on' ? true : v === 'off' ? false : undefined)
    let note = ''
    switch (word.toLowerCase()) {
      case '':
      case 'status':
        break
      case 'on':
        S.settings.on = true
        note = 'Speaking from the next response.'
        break
      case 'off':
        S.settings.on = false
        hush($)
        note = 'Quiet.'
        break
      case 'stop':
        hush($)
        return { text: 'Stopped what was being said; still on for the next response.' }
      case 'thinking':
      case 'replies': {
        const v = flag(arg)
        if (v === undefined) return { text: `Use /speak ${word} on, or /speak ${word} off.` }
        if (word === 'thinking') S.settings.thinking = v
        else S.settings.replies = v
        break
      }
      case 'rate': {
        const n = Number(arg)
        if (!Number.isFinite(n) || n < RATE_MIN || n > RATE_MAX) return { text: `Rate is words per minute, ${RATE_MIN} to ${RATE_MAX} (now ${S.settings.rate}).` }
        S.settings.rate = Math.round(n)
        break
      }
      case 'voice': {
        const [which = '', ...name] = rest
        const voice = name.join(' ')
        if ((which !== 'thinking' && which !== 'reply') || !voice) return { text: 'Use /speak voice thinking <name> or /speak voice reply <name> (/speak voices lists them).' }
        const { stdout } = await $.process.run(['say', '-v', '?'])
        const known = voiceNames(stdout)
        const match = known.find(k => k.toLowerCase() === voice.toLowerCase())
        if (!match) return { text: `No voice "${voice}" on this Mac. /speak voices lists the English ones.` }
        if (which === 'thinking') S.settings.thinkingVoice = match
        else S.settings.replyVoice = match
        break
      }
      case 'voices': {
        const { stdout } = await $.process.run(['say', '-v', '?'])
        const english = stdout
          .split('\n')
          .filter(l => /\ben_(IN|US|GB|AU|IE|ZA)\b/.test(l))
          .map(l => l.replace(/\s+#.*$/, '').replace(/\s{2,}/g, '  ').trim())
        return { text: `English voices on this Mac:\n${english.join('\n')}\n\nMore (Premium / Enhanced) in System Settings › Accessibility › Spoken Content › System voice › Manage Voices.` }
      }
      case 'live':
      case 'all':
        S.settings.pace = word as Settings['pace']
        break
      case 'test':
        enqueue($, 'thinking', ['This is how my thinking sounds.'])
        enqueue($, 'reply', ['And this is how my replies sound.'])
        return { text: `Playing a sample: thinking in ${S.settings.thinkingVoice}, reply in ${S.settings.replyVoice}.` }
      default:
        return { text: 'Unknown. /speak on | off | stop | thinking on|off | replies on|off | rate 200 | voice thinking|reply <name> | voices | live | all | test' }
    }
    await save($)
    const state = S.settings.on ? 'on' : 'off'
    const parts = [S.settings.thinking ? `thinking (${S.settings.thinkingVoice})` : null, S.settings.replies ? `replies (${S.settings.replyVoice})` : null].filter(Boolean)
    return {
      text: `${note ? `${note} ` : ''}think-aloud is ${state}: ${parts.join(' and ') || 'nothing selected'}, ${S.settings.rate} words a minute, ${S.settings.pace} pace.${S.interactive ? '' : ' (Not in this non-interactive session.)'}`,
    }
  })
}
