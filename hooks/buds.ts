import type { EngineInterface } from 'claude-code'

/**
 * Earbud taps (OPPO / OnePlus / realme buds; buds/buds.swift reads them):
 *   single tap, left          listen / stop listening: Claude Code's own dictation, added to the end of the prompt
 *                             box; stopping never sends, so the next tap adds more
 *   single tap, right         send: stops listening and sends the prompt box (an empty box: starts listening)
 *   triple tap, right / left  next block / back, as ⇧→ / ⇧←
 *   double tap, left          play/pause for videos and music (the buds and macOS do it; not seen here)
 * Every session runs its own listener and hears every tap; the session that spoke last (or was last typed to) acts:
 * it writes its id to TARGET whenever it starts saying something or gets a prompt.
 *
 * Talking presses Space in this session's own terminal (the helper types into its controlling tty), so it is Claude
 * Code's dictation in whichever mode settings.json has: "hold" (a Space held down while it listens, then
 * Enter to send) or "tap" (Space, Space). While it records, the mic chosen with /speak mic is the input ("default": whatever
 * macOS has). A Bluetooth mic puts the buds in call mode, where a tap calls Siri instead of reporting. What is
 * being said pauses while it listens and carries on after.
 */

export type BudsHooks = {
  pause: () => void
  resume: () => void
  next: () => string | undefined
  back: () => string | undefined
}

const ENGINE_HOME = '"${THINK_ALOUD_HOME:-$HOME/.claude/think-aloud}"'
const HELPER = `${ENGINE_HOME}/buds/think-aloud-buds`
/** How long a recording may run before it stops by itself (a second tap lost); it is not sent. */
const TALK_MAX_MS = 5 * 60_000
/** How long after "send" the transcript may take to reach the prompt box. */
const TRANSCRIPT_WAIT_MS = 20_000

const B = {
  state: 'off' as 'off' | 'building' | 'starting' | 'nobuds' | 'ready' | 'failed',
  name: '',
  note: '',
  listener: null as AsyncGenerator<unknown, unknown> | null,
  session: '',
  targetFile: '',
  lastMark: 0,
  talking: null as null | { holder: AsyncGenerator<unknown, unknown> | null; mic: string | null; before: string; mode: 'hold' | 'tap'; timer: { cancel: () => void } | null; hooks: BudsHooks },
}

async function sh($: EngineInterface, script: string, args: string[] = [], timeoutMs = 10_000) {
  return $.process.run(['/bin/sh', '-c', script, 'think-aloud', ...args], { timeoutMs })
}

/** This session is the one the buds talk to: it is speaking, or was just typed to. */
export async function budsTarget($: EngineInterface): Promise<void> {
  if (B.state !== 'ready' || !B.targetFile) return
  const now = await $.clock.now()
  if (now - B.lastMark < 2000) return
  B.lastMark = now
  await $.fs.write(B.targetFile, JSON.stringify({ session: B.session, at: now })).catch(() => undefined)
}

async function isTarget($: EngineInterface): Promise<boolean> {
  try {
    const t = JSON.parse(await $.fs.read(B.targetFile)) as { session?: string }
    return !t.session || t.session === B.session
  } catch {
    return true
  }
}

/** Builds the helper when it is missing or older than its source; listens for taps for the session's life. */
export async function budsStart($: EngineInterface, hooks: BudsHooks): Promise<void> {
  if (B.listener || B.state === 'building' || B.state === 'starting') return
  try {
    B.session = await $.session.id()
    const home = (await sh($, 'printf %s "$HOME"')).stdout
    B.targetFile = `${home}/.claude/think-aloud/buds-target.json`
    B.state = 'building'
    const build = await sh(
      $,
      `d=${ENGINE_HOME}/buds; mkdir -p "$d" || exit 1
       if [ ! -x "$d/think-aloud-buds" ] || [ "$1" -nt "$d/think-aloud-buds" ]; then
         xcrun swiftc -O -o "$d/think-aloud-buds.new" "$1" -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$2" 2>&1 | tail -3 &&
         mv "$d/think-aloud-buds.new" "$d/think-aloud-buds"
       fi
       test -x "$d/think-aloud-buds"`,
      [`${$.plugin.root}/buds/buds.swift`, `${$.plugin.root}/buds/Info.plist`],
      180_000,
    )
    if (build.exitCode !== 0) {
      B.state = 'failed'
      B.note = `the helper did not build (Xcode's command line tools?): ${build.stdout.trim().split('\n').pop() ?? ''}`
      return
    }
    B.state = 'starting'
    const listener = $.process.spawn({ argv: ['/bin/sh', '-c', `exec ${HELPER} listen`] })
    B.listener = listener
    for await (const { text } of listener) {
      if (B.listener !== listener) break
      for (const line of text.split('\n')) {
        const tap = /^tap ([LR]) (\d+)/.exec(line)
        if (tap) void onTap($, hooks, tap[1] as 'L' | 'R', Number(tap[2]))
        else if (line.startsWith('buds ')) {
          B.state = 'ready'
          B.name = line.slice(5).trim()
        } else if (line.startsWith('nobuds')) B.state = 'nobuds'
      }
    }
  } catch (err) {
    B.note = String(err)
  }
  B.listener = null
  if (B.state !== 'off') B.state = 'failed'
}

export function budsStop(): void {
  B.state = 'off'
  const l = B.listener
  B.listener = null
  if (l) void l.return(undefined).catch(() => undefined)
}

async function onTap($: EngineInterface, hooks: BudsHooks, side: 'L' | 'R', action: number): Promise<void> {
  try {
    if (!(await isTarget($))) return
    if (action === 1 && side === 'L') await (B.talking ? stop($) : listen($, hooks))
    else if (action === 1) {
      if (B.talking) await stop($, true)
      else if ((await $.prompt.read()).text.trim()) await type($, '0d')
      else await listen($, hooks)
    }
    else if (action === 3) {
      if (B.talking) return
      const who = side === 'R' ? hooks.next() : hooks.back()
      if (!who) $.ui.toast(side === 'R' ? 'Nothing is being said.' : 'Nothing has been said yet.')
    }
  } catch (err) {
    B.note = String(err)
  }
}

/** The bytes go into this session's own terminal, as if typed: the helper's controlling tty is the session's. */
async function type($: EngineInterface, hex: string): Promise<boolean> {
  return (await sh($, `exec ${HELPER} type "$1"`, [hex])).exitCode === 0
}

async function voiceMode($: EngineInterface): Promise<'hold' | 'tap' | 'off'> {
  try {
    const home = B.targetFile.replace(/\/\.claude\/think-aloud\/.*$/, '')
    const s = JSON.parse(await $.fs.read(`${home}/.claude/settings.json`)) as { voiceEnabled?: boolean; voice?: { enabled?: boolean; mode?: string } }
    if (s.voice?.enabled === false || (s.voice?.enabled === undefined && s.voiceEnabled !== true)) return 'off'
    return s.voice?.mode === 'tap' ? 'tap' : 'hold'
  } catch {
    return 'hold'
  }
}

function chime($: EngineInterface, name: 'Tink' | 'Pop'): void {
  void $.process.run(['afplay', '-v', '0.4', `/System/Library/Sounds/${name}.aiff`]).catch(() => undefined)
}

/** Dictation starts, added to the end of what the prompt box holds; what is being said pauses meanwhile. */
async function listen($: EngineInterface, hooks: BudsHooks): Promise<void> {
  const mode = await voiceMode($)
  if (mode === 'off') {
    $.ui.toast('Turn on Claude Code voice first: /voice')
    return
  }
  const box = await $.prompt.read()
  if (mode === 'tap' && box.text.trim()) {
    $.ui.toast("Claude Code's tap mode starts only in an empty prompt box: /voice hold adds to what is there.")
    return
  }
  // Dictation goes in at the cursor: the end, so it adds to what is there.
  if (box.cursor !== box.text.length) await $.prompt.fill({ text: box.text, mode: 'replace' })
  hooks.pause()
  // The mic chosen with /speak mic while it records; the default input comes back after.
  let restore: string | null = null
  if (budsMic !== 'default') {
    const all = await mics($)
    const want = all.find(m => m.name === budsMic)
    const now = all.find(m => m.isDefault)
    if (!want) $.ui.toast(`${budsMic} is not connected: recording from the default mic.`)
    else if (want !== now && (await sh($, `exec ${HELPER} mic "$1"`, [want.id])).exitCode === 0) restore = now?.id ?? null
  }
  chime($, 'Tink')
  let holder: AsyncGenerator<unknown, unknown> | null = null
  if (mode === 'hold') {
    holder = $.process.spawn({ argv: ['/bin/sh', '-c', `exec ${HELPER} hold`] })
    const h = holder
    void (async () => {
      // Runs until "stop" ends it.
      for await (const piece of h) void piece
    })().catch(() => undefined)
  } else await type($, '20')
  const timer = $.clock.after(TALK_MAX_MS, () => void stop($))
  B.talking = { holder, mic: restore, before: box.text, mode, timer, hooks }
  $.ui.toast('🎙 Listening: tap left to stop, right to send')
}

/** Listening stops; what is being said carries on. With `send`, the prompt box goes once its new words are in it. */
async function stop($: EngineInterface, send = false): Promise<void> {
  const t = B.talking
  if (!t) return
  B.talking = null
  t.timer?.cancel()
  if (t.holder) await t.holder.return(undefined).catch(() => undefined)
  else await type($, '20')
  chime($, 'Pop')
  t.hooks.resume()
  // The words were heard; the input goes back to what it was once the recorder has let go.
  if (t.mic) $.clock.after(1500, () => void sh($, `exec ${HELPER} mic "$1"`, [t.mic!]))
  // Tap mode sends three words or more by itself; anything else waits in the box, and "send" sends it once the
  // transcript has landed (the box has changed and held still for a moment).
  if (!send) return
  const start = await $.clock.now()
  let last = t.before
  let steady = 0
  while ((await $.clock.now()) - start < TRANSCRIPT_WAIT_MS) {
    await $.clock.sleep(300)
    const text = (await $.prompt.read()).text
    if (text !== t.before && text.trim()) {
      steady = text === last ? steady + 1 : 0
      if (steady >= 3) {
        await type($, '0d')
        return
      }
    } else if (t.mode === 'tap' && (await $.clock.now()) - start > 4000) return // sent by itself
    last = text
  }
  // Nothing new was heard: what was in the box goes as it is.
  if ((await $.prompt.read()).text.trim()) await type($, '0d')
}

export type Mic = { id: string; isDefault: boolean; kind: string; name: string }

/** The Mac's inputs, as the helper lists them ("<id>\t<default>\t<kind>\t<name>"). */
export async function mics($: EngineInterface): Promise<Mic[]> {
  const r = await sh($, `exec ${HELPER} mics`).catch(() => null)
  return (r?.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [id = '', d = '', kind = '', ...name] = l.split('\t')
      return { id, isDefault: d === '1', kind, name: name.join('\t') }
    })
}

/** The mic that records while talking by the buds: "default" (macOS's input) or an input's name (/speak mic). */
let budsMic = 'default'
export function setBudsMic(m: string): void {
  budsMic = m
}

export async function budsSetup($: EngineInterface): Promise<string> {
  const r = await sh($, `exec ${HELPER} setup`, [], 30_000).catch(e => ({ exitCode: 1, stdout: String(e), stderr: '' }))
  if (r.exitCode !== 0) return `Could not set the buds' gestures (${r.stdout.trim().split('\n').pop() || 'no answer'}). Are they connected?`
  return 'Gestures set: tap left = listen / stop, tap right = send, triple tap right = next, triple tap left = back, double tap left = play/pause.'
}

export function budsNow(on: boolean): string {
  if (!on) return 'Buds: off.'
  const what = { off: 'off', building: 'building the helper', starting: 'starting', nobuds: 'no buds connected', ready: `listening to ${B.name}`, failed: `not working (${B.note})` }[B.state]
  return `Buds: ${what}; talking records from ${budsMic === 'default' ? 'the default mic' : budsMic}${B.talking ? '; recording now' : ''}.`
}
