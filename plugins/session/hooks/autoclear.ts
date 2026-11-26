// Pure decision for the auto-clear mod: plain values in, a verdict out.
// register.tsx gathers the values; nothing here touches the engine.

export const FLAG_TTL_SEC = 1800
export const BACKSTOP_PER_HOUR = 12

export type Flag = { session_id: string; pointer: string; created_at: number }

export type Input = {
  flag: Flag | null
  nowSec: number
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  draft: string
  lastClearSec: number | undefined
  clearsLastHour: number
  minGapMinutes: number
}

export type Verdict =
  | { action: 'clear' }
  | { action: 'skip'; reason: string; dropFlag: boolean; notify: boolean }

const drop = (reason: string): Verdict => ({ action: 'skip', reason, dropFlag: true, notify: true })

export function decide(i: Input): Verdict {
  if (!i.flag) return { action: 'skip', reason: 'no-flag', dropFlag: false, notify: false }
  if (i.nowSec - i.flag.created_at > FLAG_TTL_SEC) return drop('stale-flag')
  if (i.reason === 'aborted') return drop('interrupted')
  if (i.reason !== 'answer') return drop(i.reason)
  if (i.draft !== '') return drop('draft')
  if (i.minGapMinutes > 0 && i.lastClearSec !== undefined && i.nowSec - i.lastClearSec < i.minGapMinutes * 60) return drop('min-gap')
  if (i.clearsLastHour >= BACKSTOP_PER_HOUR) return drop('backstop')
  return { action: 'clear' }
}
