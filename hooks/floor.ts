import type { EngineInterface } from 'claude-code'

/**
 * One voice at a time across sessions: each session's speech waits for "the floor" (FLOOR, a small file every session
 * reads), so two sessions working at once never talk over each other. A session keeps the floor while it is mid-flow
 * (GRACE_MS after each utterance), and hands it over after TURN_MS when another has been waiting. When the voice
 * changes session, the new one says its name first, so it is clear whose work is being heard.
 */

/** After an utterance ends, the floor stays this long: the same session's next line follows without another between. */
const GRACE_MS = 2500
/** A session that has spoken this long while another waits hands the floor over. */
const TURN_MS = 20_000
/** How often a waiting session looks again. */
const POLL_MS = 250

type Floor = { holder: string; until: number; since: number; last: string }
type Want = { since: number; at: number }

const F = { dir: '', me: '', name: '', since: 0 }

async function home($: EngineInterface): Promise<string> {
  return (await $.process.run(['/bin/sh', '-c', 'printf %s "$HOME"'])).stdout
}

/** This session's name as said aloud: its name (/rename, a background session's), else its folder's. */
async function nameOf($: EngineInterface, h: string, me: string): Promise<string> {
  const jobs = `${h}/.claude/jobs`
  for (const e of await $.fs.list(jobs).catch(() => [])) {
    try {
      const s = JSON.parse(await $.fs.read(`${jobs}/${e.name}/state.json`)) as { name?: string; sessionId?: string }
      if (s.sessionId === me && s.name) return s.name
    } catch {
      // not a session's
    }
  }
  const cwd = await $.session.cwd()
  return cwd.split('/').pop() || 'another session'
}

export async function floorInit($: EngineInterface): Promise<void> {
  if (F.dir) return
  const h = await home($)
  F.me = await $.session.id()
  F.name = (await nameOf($, h, F.me)).replace(/([a-z])(\d)/gi, '$1 $2')
  F.dir = `${h}/.claude/think-aloud/floor`
}

async function readFloor($: EngineInterface): Promise<Floor | null> {
  try {
    return JSON.parse(await $.fs.read(`${F.dir}/floor.json`)) as Floor
  } catch {
    return null
  }
}

async function writeFloor($: EngineInterface, f: Floor): Promise<void> {
  await $.fs.write(`${F.dir}/floor.json`, JSON.stringify(f))
}

/** Another session waiting long enough to be given the floor. */
async function someoneWaits($: EngineInterface, now: number): Promise<boolean> {
  for (const e of await $.fs.list(F.dir).catch(() => [])) {
    if (!e.name.startsWith('want.') || e.name === `want.${F.me}`) continue
    try {
      const w = JSON.parse(await $.fs.read(`${F.dir}/${e.name}`)) as Want
      if (now - w.at < 2 * POLL_MS + 1000 && now - w.since > 3000) return true
    } catch {
      // gone meanwhile
    }
  }
  return false
}

/**
 * Waits for the floor (or `stop` aborts: a hush), then holds it; the line to say first when the voice has just come
 * over from another session (its name), else ''.
 */
export async function floorTake($: EngineInterface, stop: () => boolean): Promise<string> {
  if (!F.dir) await floorInit($)
  const wantFile = `${F.dir}/want.${F.me}`
  let since = 0
  for (;;) {
    const now = await $.clock.now()
    const f = await readFloor($)
    const mine = f?.holder === F.me && f.until > now
    const free = !f || f.until <= now
    // Mine, but another has waited and this turn has run long: hand it over, and queue behind them.
    const yieldNow = mine && now - (f?.since ?? now) > TURN_MS && (await someoneWaits($, now))
    if ((mine || free) && !yieldNow) {
      const switched = !mine && !!f?.last && f.last !== F.me
      await writeFloor($, { holder: F.me, until: now + 60_000, since: mine ? f!.since : now, last: F.me })
      // Two sessions taking a free floor at once: the write that stands wins.
      await $.clock.sleep(40)
      if ((await readFloor($))?.holder === F.me) {
        // No longer waiting (the fs has no delete: an empty want counts for nothing).
        if (since) void $.fs.write(wantFile, '{}').catch(() => undefined)
        return switched ? `${F.name}.` : ''
      }
    } else if (yieldNow) {
      // Handed over once the line playing now has ended (until, less the grace); the one waiting takes it then, and
      // this session waits a moment longer so it does not take it straight back.
      const end = f!.until - GRACE_MS
      await writeFloor($, { ...f!, holder: '', until: end })
      since = now
      await $.clock.sleep(Math.max(0, end - now) + 1000)
      continue
    }
    if (stop()) return ''
    since ||= now
    await $.fs.write(wantFile, JSON.stringify({ since, at: now } satisfies Want)).catch(() => undefined)
    await $.clock.sleep(POLL_MS)
  }
}

/** The utterance just started plays about `playMs`: the floor is kept until then, and a moment after. */
export async function floorPlaying($: EngineInterface, playMs: number): Promise<void> {
  const now = await $.clock.now()
  const f = await readFloor($)
  if (f?.holder === F.me) await writeFloor($, { ...f, until: now + playMs + GRACE_MS })
}

/** Nothing more to say here (a hush, a failed line): the floor is free now. */
export async function floorFree($: EngineInterface): Promise<void> {
  if (!F.dir) return
  const f = await readFloor($)
  if (f?.holder === F.me) await writeFloor($, { ...f, until: 0 })
}

/** The person is talking by the buds: nobody speaks until it is released (floorFree). */
export async function floorHush($: EngineInterface): Promise<void> {
  if (!F.dir) await floorInit($)
  const now = await $.clock.now()
  const f = await readFloor($)
  await writeFloor($, { holder: F.me, until: now + 10 * 60_000, since: now, last: f?.last ?? F.me })
}
