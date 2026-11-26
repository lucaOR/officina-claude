# Handoff auto-clear mod Implementation Plan

**Goal:** After /session:handoff writes its note, the session clears itself and the successor starts from the pointer with nobody at the keyboard.

**Architecture:** A hooks module (mod) in the session plugin listens for turn.complete. The handoff skill arms it with a per-session flag file holding the pointer; the mod runs /clear, then submits the pointer in the new session, behind a minimum-age guard.

**Tech Stack:** Claude Code 2.1.332 mod API (TypeScript hooks module, $.command.run, $.prompt.submit, $.store), Python 3 for the skill-side script and tests, claude plugin test for the mod.

**Spec:** docs/superpowers/specs/2026-11-26-handoff-auto-clear-design.md

## Global Constraints

- Without mod support the skill behaves exactly as today: the pointer is always printed.
- The submitted pointer keeps the HANDOFF v1 sentinel so record-session-metrics.js still links parent and child.
- No auto-clear fires mid-turn, after a user interrupt, over a draft, or from a flag older than 30 minutes.
- Existing SessionStart:clear hooks (pivot-gate, inherit-handoff-title) must still fire on the auto clear.
- The age guard is keyed per project; the pointer lives in the mod instance, never in the shared store.

## Review Focus

- Flag exactly 1800 s old fires; 1801 s is dropped. Test: T3.
- Turn interrupted (reason aborted) with a fresh flag: no clear, flag dropped. Test: T3.
- Pointer submitted exactly once, and only in the session after the clear. Test: T4.
- Two sessions writing the shared store at once do not corrupt it. Test: T5.

## Decisions

### D1: How does the mod learn a handoff just finished?

**Pick:** (a) Flag file written by the skill — User chose A: explicit signal, no false clears.

### D2: Is auto-clear opt-in or always on?

**Pick:** (a) Always after /handoff — User: always clear automatically; the goal is not to wait at the computer.

### D3: What stops a runaway handoff loop?

**Pick:** (b) Minimum 10 min since last auto-clear, 12 per hour backstop — User agreed 3/hour is too stringent for heavy sessions; age-based guard fits.

### D4: Where do the mod files live next to the existing command hooks?

**Pick:** (a) Add a modules entry to the existing hooks/hooks.json — One manifest, nothing new to install. Needs claude plugin validate to accept hooks and modules together.

### D5: How does the pointer reach the new session after the clear?

**Pick:** (a) Hold it in the mod instance, submit from session.start after the clear — Each Claude Code process has its own instance, so two sessions cannot collide. The instance survives /clear (auto-clear-context relies on this). Lost only if the process dies mid-clear.

### D6: Who writes the flag file?

**Pick:** (a) New script arm_autoclear.py called from skill step 5 — Deterministic and unit-testable like collect.py; the model cannot get the format wrong.

### D7: When a check fails, drop the flag or retry later?

**Pick:** (a) Drop the flag, toast the reason, user clears by hand — Simple; a draft or interrupt means the user is back, so they drive.

---

### Task 1: Check that hooks and modules can share hooks/hooks.json

**Implements:** D4

**Files:**
- Modify: `plugins/session/hooks/hooks.json (scratch copy first)`

**Interfaces:**
- Consumes: claude plugin validate; existing hooks/hooks.json with a top-level hooks key
- Produces: A yes/no on D4 option a; if no, the plan returns to D4 (fallback option c, separate plugin)

- [ ] **Step 1: Copy the plugin to a scratch folder**

cp -r plugins/session into the scratchpad; work only on the copy.

Run: `cp -r plugins/session "$SCRATCH/session-copy"`

Expected: PASS

- [ ] **Step 2: Add an empty modules entry and a stub module**

In the copy, add "modules": ["./register.tsx"] next to the existing hooks key and create hooks/register.tsx exporting register = () => {}.

```json
{ "modules": ["./register.tsx"], "hooks": { "SessionStart": [] } }
```

- [ ] **Step 3: Validate the copy**

The command must report no error about the combined manifest. If it refuses, stop and reopen D4.

Run: `claude plugin validate "$SCRATCH/session-copy"`

Expected: PASS

```bash
chore(session): record that hooks.json can carry modules (no repo change if scratch only)
```

### Task 2: Flag file writer arm_autoclear.py and the handoff skill step

**Implements:** D1, D6

**Files:**
- Create: `plugins/session/skills/handoff/scripts/arm_autoclear.py`
- Create: `plugins/session/skills/handoff/scripts/test_arm_autoclear.py`
- Modify: `plugins/session/skills/handoff/SKILL.md`
- Test: `plugins/session/skills/handoff/scripts/test_arm_autoclear.py`

**Interfaces:**
- Consumes: lineage.SESSION_ID_RE; the pointer line the skill prints
- Produces: arm(session_id: str, pointer: str, home: Path | None = None, now: int | None = None) -> Path writes <home>/.claude/handoff/<session_id>.autoclear as JSON {session_id, pointer, created_at}; CLI: arm_autoclear.py <session_id> <pointer> prints the path

- [ ] **Step 1: Write the failing test**

Plain unittest, no pytest on this host.

```python
class ArmTest(unittest.TestCase):
    def test_writes_flag_json(self):
        ptr = "read /n.md — HANDOFF v1 mode=mid parent=s"
        with tempfile.TemporaryDirectory() as home:
            p = arm_autoclear.arm("s", ptr, home=Path(home), now=1000)
            self.assertEqual(p, Path(home) / ".claude" / "handoff" / "s.autoclear")
            self.assertEqual(json.loads(p.read_text()), {"session_id": "s", "pointer": ptr, "created_at": 1000})

    def test_rejects_bad_session_id(self):
        with self.assertRaises(ValueError):
            arm_autoclear.arm("../x", "read /n.md — HANDOFF v1 mode=mid parent=s", home=Path("/tmp"), now=1)

    def test_rejects_pointer_without_sentinel(self):
        with self.assertRaises(ValueError):
            arm_autoclear.arm("s", "hello", home=Path("/tmp"), now=1)
```

- [ ] **Step 2: Run it**

Run: `python3 -m unittest plugins/session/skills/handoff/scripts/test_arm_autoclear.py`

Expected: FAIL

- [ ] **Step 3: Implement arm()**

In arm_autoclear.py: validate session_id with lineage.SESSION_ID_RE and require 'HANDOFF v1' in the pointer, else ValueError; write the JSON atomically (temp file then rename) under ~/.claude/handoff/ created with parents.

- [ ] **Step 4: Add the skill step**

In SKILL.md step 5, before emitting the pointer, run arm_autoclear.py with the session id and the pointer; say in one line above the pointer that the session will clear itself when mods are on and that the pointer is the manual fallback.

- [ ] **Step 5: Run it again**

Run: `python3 -m unittest plugins/session/skills/handoff/scripts/test_arm_autoclear.py`

Expected: PASS

```bash
feat(session): arm_autoclear.py writes the auto-clear flag at handoff
```

### Task 3: Pure decision function autoclear.ts

**Implements:** D2, D3, D7

**Files:**
- Create: `plugins/session/hooks/autoclear.ts`
- Create: `plugins/session/hooks/autoclear.test.ts`
- Test: `plugins/session/hooks/autoclear.test.ts`

**Interfaces:**
- Consumes: Nothing from the engine; plain values only
- Produces: decide(i: {flag: Flag | null; nowSec: number; reason: 'answer'|'aborted'|'refusal'|'error'; draft: string; lastClearSec: number | undefined; clearsLastHour: number; minGapMinutes: number}): {action: 'clear'} | {action: 'skip'; reason: string; dropFlag: boolean; notify: boolean}. Constants FLAG_TTL_SEC = 1800, BACKSTOP_PER_HOUR = 12

- [ ] **Step 1: Write the failing tests**

Base input: flag {session_id:'s', pointer:'read /n.md — HANDOFF v1 mode=mid parent=s', created_at:1000}, nowSec 1100, reason 'answer', draft '', lastClearSec undefined, clearsLastHour 0, minGapMinutes 10.

```typescript
test('clears when every check passes', () => expect(decide(base)).toEqual({ action: 'clear' }))
test('no flag is a silent skip', () => expect(decide({ ...base, flag: null })).toEqual({ action: 'skip', reason: 'no-flag', dropFlag: false, notify: false }))
test('flag older than 1800 s is dropped', () => expect(decide({ ...base, nowSec: 2801 })).toEqual({ action: 'skip', reason: 'stale-flag', dropFlag: true, notify: true }))
test('flag exactly 1800 s old still fires', () => expect(decide({ ...base, nowSec: 2800 })).toEqual({ action: 'clear' }))
test('aborted turn drops the flag', () => expect(decide({ ...base, reason: 'aborted' })).toEqual({ action: 'skip', reason: 'interrupted', dropFlag: true, notify: true }))
test('a draft drops the flag', () => expect(decide({ ...base, draft: 'abc' })).toEqual({ action: 'skip', reason: 'draft', dropFlag: true, notify: true }))
test('599 s since last clear refuses', () => expect(decide({ ...base, lastClearSec: 501 })).toEqual({ action: 'skip', reason: 'min-gap', dropFlag: true, notify: true }))
test('600 s since last clear passes', () => expect(decide({ ...base, lastClearSec: 500 })).toEqual({ action: 'clear' }))
test('12 clears in the hour refuses', () => expect(decide({ ...base, clearsLastHour: 12 })).toEqual({ action: 'skip', reason: 'backstop', dropFlag: true, notify: true }))
test('minGapMinutes 0 disables the gap but not the backstop', () => { expect(decide({ ...base, lastClearSec: 1099, minGapMinutes: 0 })).toEqual({ action: 'clear' }); expect(decide({ ...base, clearsLastHour: 12, minGapMinutes: 0 }).action).toBe('skip') })
```

- [ ] **Step 2: Run it**

Run: `claude plugin test plugins/session`

Expected: FAIL

- [ ] **Step 3: Implement decide()**

Check in this order: no flag, stale (age > FLAG_TTL_SEC), reason !== 'answer', draft !== '', gap (only when minGapMinutes > 0 and lastClearSec defined and nowSec - lastClearSec < minGapMinutes*60), backstop. Export Flag type and both constants.

- [ ] **Step 4: Run it again**

Run: `claude plugin test plugins/session`

Expected: PASS

```bash
feat(session): pure auto-clear decision with age guard and backstop
```

### Task 4: Wire the mod: turn.complete, clear, resume, toast, option

**Implements:** D1, D2, D4, D5

**Files:**
- Create: `plugins/session/hooks/register.tsx`
- Create: `plugins/session/hooks/register.test.ts`
- Modify: `plugins/session/hooks/hooks.json`
- Modify: `plugins/session/.claude-plugin/plugin.json`
- Modify: `plugins/session/README.md`
- Test: `plugins/session/hooks/register.test.ts`

**Interfaces:**
- Consumes: decide() from T3; flag JSON from T2; $.command.run, $.prompt.submit, $.prompt.read, $.store, $.fs, $.ui.toast, $.session.id() if present (check types)
- Produces: register(on, options) with options.minGapMinutes (userConfig, default 10, 0 disables); store key clears:<project dir> holding an array of epoch seconds

- [ ] **Step 1: Write the failing tests**

Using the engine kit: a fresh flag for the current session plus reason 'answer' leads to one /clear; after session.start the pointer is submitted exactly once; with no flag nothing runs; a skip shows a toast and deletes the flag; a second arm inside 10 minutes is refused.

```typescript
test('fresh flag clears once and submits the pointer once', async () => { /* seed flag file, raise turn.complete, assert one command.run {command:'clear'}, raise session.start, assert one prompt.submit with the flag pointer */ })
test('no flag does nothing', async () => { /* raise turn.complete, assert no command.run and no toast */ })
test('draft skips, toasts the reason and deletes the flag', async () => { /* prompt.read returns draft 'x' */ })
test('second clear inside the gap is refused', async () => { /* store holds a clear 300 s ago */ })
```

- [ ] **Step 2: Run it**

Run: `claude plugin test plugins/session`

Expected: FAIL

- [ ] **Step 3: Implement register()**

On turn.complete: read <session-id>.autoclear (ignore other sessions' flags), read the draft with $.prompt.read(), the per-project clear history from $.store, call decide(). On clear: hold the pointer in a module variable, record the timestamp, delete the flag, run $.command.run({command:'clear'}). On session.start: if a held pointer exists, submit it once and drop it. On a skip with notify: $.ui.toast('auto-clear skipped: <reason>') and delete the flag when dropFlag.

- [ ] **Step 4: Register the module and option**

Add the modules entry to hooks/hooks.json (as validated in T1), add userConfig minGapMinutes to plugin.json, bump the version, add a README line on what the mod does and that mods must be allowed.

- [ ] **Step 5: Run it again**

Run: `claude plugin test plugins/session && claude plugin validate plugins/session`

Expected: PASS

```bash
feat(session): auto-clear mod clears and resumes after a handoff
```

### Task 5: Live check in a scratch session

**Implements:** D5

**Interfaces:**
- Consumes: The installed mod from T4, run with claude --plugin-dir plugins/session in a scratch project
- Produces: A written result for each scenario S1 to S7; any failure reopens the owning decision

- [ ] **Step 1: Run S1 and S6**

In a scratch project, do some work, run /session:handoff, watch the clear and the submitted pointer. Confirm the instance survives /clear (the pointer is submitted by the same instance), pivot-gate and inherit-handoff-title fire, and the metrics row has the parent link. Then repeat with two terminals at once and confirm each resumes its own pointer and the shared store file is not corrupted.

Run: `claude --plugin-dir plugins/session`

Expected: PASS

- [ ] **Step 2: Run S2 to S5 and S7**

Answer an ordinary question (nothing happens); wait 31 minutes or edit created_at (flag dropped); type a draft before the turn ends (toast, no clear); run a second handoff within 10 minutes (refused); start with mods off (printed pointer only).

```bash
chore(session): record the live auto-clear check
```
