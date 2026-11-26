import { expect, test } from 'claude-code/testing'

const SID = 'c65279cd-3a7c-40a7-85a3-ab24061676fc'
const PTR = `read /n.md — HANDOFF v1 mode=mid parent=${SID}`
const NOW_MS = 1_000_000 * 1000

function seed(on: any, opts: { flagAge?: number; draft?: string; store?: Record<string, unknown> } = {}) {
  const files: Record<string, string> = {
    [`/home/u/.claude/handoff/${SID}.autoclear`]: JSON.stringify({ session_id: SID, pointer: PTR, created_at: 1_000_000 - (opts.flagAge ?? 10) }),
  }
  const ran: string[] = []
  const submitted: string[] = []
  const toasts: string[] = []
  on('turn.complete', () => ({ text: '' }))
  on('session.id', () => ({ value: SID }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('env.get', () => ({ value: '/home/u' }))
  on('clock.now', () => ({ value: NOW_MS }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_: any, e: any) => ({ value: files[e.path] }))
  on('fs.write', (_: any, e: any) => { files[e.path] = e.text; return { value: undefined } })
  on('prompt.read', () => ({ value: { text: opts.draft ?? '', cursor: 0 } }))
  on('store.get', (_: any, e: any) => ({ value: opts.store?.[e.key] }))
  on('store.set', () => ({ value: undefined }))
  on('command.run', (_: any, e: any) => { ran.push(e.command); return { text: '' } })
  on('prompt.submit', (_: any, e: any) => { submitted.push(e.text); return { text: e.text } })
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  return { files, ran, submitted, toasts }
}

test('fresh flag clears once and submits the pointer once', async ($, on) => {
  const s = seed(on)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  expect(s.ran).toEqual(['clear'])
  for (let i = 0; i < 20; i++) await Promise.resolve()
  expect(s.submitted).toEqual([PTR])
})

test('no flag does nothing', async ($, on) => {
  const s = seed(on)
  s.files[`/home/u/.claude/handoff/${SID}.autoclear`] = ''
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  expect(s.ran).toEqual([])
  expect(s.toasts).toEqual([])
})

test('draft skips, toasts the reason and consumes the flag', async ($, on) => {
  const s = seed(on, { draft: 'x' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  expect(s.ran).toEqual([])
  expect(s.toasts).toEqual(['auto-clear skipped: draft'])
  expect(s.files[`/home/u/.claude/handoff/${SID}.autoclear`]).toBe('')
})

test('second clear inside the gap is refused', async ($, on) => {
  const s = seed(on, { store: { 'clears:/proj': [1_000_000 - 300] } })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  expect(s.ran).toEqual([])
  expect(s.toasts).toEqual(['auto-clear skipped: min-gap'])
})
