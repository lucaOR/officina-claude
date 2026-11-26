import { expect, test } from 'claude-code/testing'
import { decide, type Input } from './autoclear'

const base: Input = {
  flag: { session_id: 's', pointer: 'read /n.md — HANDOFF v1 mode=mid parent=s', created_at: 1000 },
  nowSec: 1100,
  reason: 'answer',
  draft: '',
  lastClearSec: undefined,
  clearsLastHour: 0,
  minGapMinutes: 10,
}

test('clears when every check passes', () => expect(decide(base)).toEqual({ action: 'clear' }))
test('no flag is a silent skip', () => expect(decide({ ...base, flag: null })).toEqual({ action: 'skip', reason: 'no-flag', dropFlag: false, notify: false }))
test('flag older than 1800 s is dropped', () => expect(decide({ ...base, nowSec: 2801 })).toEqual({ action: 'skip', reason: 'stale-flag', dropFlag: true, notify: true }))
test('flag exactly 1800 s old still fires', () => expect(decide({ ...base, nowSec: 2800 })).toEqual({ action: 'clear' }))
test('aborted turn drops the flag', () => expect(decide({ ...base, reason: 'aborted' })).toEqual({ action: 'skip', reason: 'interrupted', dropFlag: true, notify: true }))
test('a draft drops the flag', () => expect(decide({ ...base, draft: 'abc' })).toEqual({ action: 'skip', reason: 'draft', dropFlag: true, notify: true }))
test('599 s since last clear refuses', () => expect(decide({ ...base, lastClearSec: 501 })).toEqual({ action: 'skip', reason: 'min-gap', dropFlag: true, notify: true }))
test('600 s since last clear passes', () => expect(decide({ ...base, lastClearSec: 500 })).toEqual({ action: 'clear' }))
test('12 clears in the hour refuses', () => expect(decide({ ...base, clearsLastHour: 12 })).toEqual({ action: 'skip', reason: 'backstop', dropFlag: true, notify: true }))
test('minGapMinutes 0 disables the gap but not the backstop', () => {
  expect(decide({ ...base, lastClearSec: 1099, minGapMinutes: 0 })).toEqual({ action: 'clear' })
  expect(decide({ ...base, clearsLastHour: 12, minGapMinutes: 0 }).action).toBe('skip')
})
