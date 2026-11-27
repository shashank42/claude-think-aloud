import type { EngineInterface } from 'claude-code'

/**
 * One voice at a time across sessions: each session's speech waits for "the floor" (a small file every session reads),
 * so two sessions working at once never talk over each other, and nothing is cut off to make room. A session keeps the
 * floor while it has more to say (its speech is running, or it spoke less than GRACE_MS ago); the others wait their
 * turn, first come first served. A soft cue (`cue`) says something new has joined the queue, so the person can skip
 * ahead (next) or let it play; when the voice changes session, the new one says its name first.
 */

/** After the last line ends, the floor stays this long: the same session's next thought follows on, not another's. */
const GRACE_MS = 6000
/** How often a waiting session looks again. */
const POLL_MS = 250
/** A want not written again for this long is a session that stopped waiting (or ended). */
const WANT_STALE_MS = 2000

type Floor = { holder: string; until: number; last: string }
type Want = { since: number; at: number }

const F = { dir: '', me: '', name: '', cueAt: 0 }

/** The soft sound for "something new is queued" (another session's, or a new thought here); one per 3 s at most. */
export async function cue($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (now - F.cueAt < 3000) return
  F.cueAt = now
  void $.process.run(['afplay', '-v', '0.35', '/System/Library/Sounds/Morse.aiff']).catch(() => undefined)
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
  const h = (await $.process.run(['/bin/sh', '-c', 'printf %s "$HOME"'])).stdout
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

/** Another session that has waited longer than `since` and still waits: it goes first. */
async function ahead($: EngineInterface, since: number, now: number): Promise<boolean> {
  for (const e of await $.fs.list(F.dir).catch(() => [])) {
    if (!e.name.startsWith('want.') || e.name === `want.${F.me}`) continue
    try {
      const w = JSON.parse(await $.fs.read(`${F.dir}/${e.name}`)) as Partial<Want>
      if (w.at !== undefined && w.since !== undefined && now - w.at < WANT_STALE_MS && w.since < since) return true
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
    if (f?.holder === F.me && f.until > now) {
      // Mine still: this line follows on (kept while it is prepared; its playing time is set when it starts).
      await writeFloor($, { ...f, until: Math.max(f.until, now + 15_000) })
      return ''
    }
    if ((!f || f.until <= now) && !(await ahead($, since || now, now))) {
      await writeFloor($, { holder: F.me, until: now + 15_000, last: F.me })
      // Two sessions taking a free floor at once: the write that stands wins.
      await $.clock.sleep(40)
      if ((await readFloor($))?.holder === F.me) {
        // No longer waiting (the fs has no delete: an empty want counts for nothing).
        if (since) void $.fs.write(wantFile, '{}').catch(() => undefined)
        return f?.last && f.last !== F.me ? `${F.name}.` : ''
      }
    }
    if (stop()) {
      if (since) void $.fs.write(wantFile, '{}').catch(() => undefined)
      return ''
    }
    // Waiting behind another session's speech: once, a cue that something new is queued.
    if (!since) void cue($)
    since ||= now
    await $.fs.write(wantFile, JSON.stringify({ since, at: now } satisfies Want)).catch(() => undefined)
    await $.clock.sleep(POLL_MS)
  }
}

/** The utterance just started plays about `playMs`: the floor is kept until then, and GRACE_MS after. */
export async function floorPlaying($: EngineInterface, playMs: number): Promise<void> {
  const now = await $.clock.now()
  const f = await readFloor($)
  if (f?.holder === F.me) await writeFloor($, { ...f, until: Math.max(f.until, now + playMs + GRACE_MS) })
}

/** Speech here is still running (a thought being prepared): the floor is kept a while longer. */
export async function floorKeep($: EngineInterface): Promise<void> {
  if (!F.dir) return
  const now = await $.clock.now()
  const f = await readFloor($)
  if (f?.holder === F.me && f.until > now) await writeFloor($, { ...f, until: Math.max(f.until, now + GRACE_MS) })
}

/** The person has stopped talking: what was held here carries on, the floor kept GRACE_MS (its next line takes it again). */
export async function floorResume($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const f = await readFloor($)
  if (f?.holder === F.me) await writeFloor($, { ...f, until: now + GRACE_MS })
}

/** Nothing more to say here (a hush, a failed line): the floor is free now. */
export async function floorFree($: EngineInterface): Promise<void> {
  if (!F.dir) return
  const f = await readFloor($)
  if (f?.holder === F.me) await writeFloor($, { ...f, until: 0 })
}

/** The person is talking by the buds: nobody speaks until it is released (floorResume, or floorFree). */
export async function floorHush($: EngineInterface): Promise<void> {
  if (!F.dir) await floorInit($)
  const now = await $.clock.now()
  const f = await readFloor($)
  await writeFloor($, { holder: F.me, until: now + 10 * 60_000, last: f?.last ?? F.me })
}
