import type { Register } from 'claude-code'
import { decide, type Flag } from './autoclear'

const HOUR = 3600

// A flag file is "consumed" by overwriting it with nothing: $.fs has no delete.
const CONSUMED = ''

function parseFlag(text: string, sessionId: string): Flag | null {
  try {
    const f = JSON.parse(text)
    if (f && f.session_id === sessionId && typeof f.pointer === 'string' && typeof f.created_at === 'number') return f
  } catch {}
  return null
}

// Runs detached: /clear is queued until the session is idle, and it resolves
// once the new session is in place, so the pointer goes in right after it.
// A classic.SessionStart hook is no use here: an organization's managed hook can
// cut it out of the chain.
async function clearThenResume($: any, text: string) {
  await $.command.run({ command: 'clear' })
  await $.prompt.submit({ text })
}

export const register: Register = (on, options) => {
  const minGapMinutes = Number(options.minGapMinutes ?? 10)
  on('turn.complete', async ($, e, next) => {
    const sessionId = await $.session.id()
    const home = await $.env.get('HOME')
    if (!home) return next(e)
    const path = `${home}/.claude/handoff/${sessionId}.autoclear`
    if (!(await $.fs.exists(path))) return next(e)

    const flag = parseFlag(await $.fs.read(path), sessionId)
    const cwd = await $.session.cwd()
    const key = `clears:${cwd}`
    const nowSec = Math.floor((await $.clock.now()) / 1000)
    const history = ((await $.store.get(key)) as number[] | undefined ?? []).filter(t => nowSec - t < HOUR)
    const draft = (await $.prompt.read()).text

    const v = decide({
      flag,
      nowSec,
      reason: e.reason,
      draft,
      lastClearSec: history.length ? Math.max(...history) : undefined,
      clearsLastHour: history.length,
      minGapMinutes,
    })

    if (v.action === 'skip') {
      if (v.dropFlag) await $.fs.write(path, CONSUMED)
      if (v.notify) $.ui.toast(`auto-clear skipped: ${v.reason}`)
      return next(e)
    }

    await $.store.set(key, [...history, nowSec])
    await $.fs.write(path, CONSUMED)
    const result = await next(e)
    void clearThenResume($, flag!.pointer)
    return result
  })
}
