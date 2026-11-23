#!/usr/bin/env python3
"""Run the reviewer drift fixtures through the live reviewer.

usage: eval_reviewer.py [--reps N] [--case NAME] [--prompt PATH] [--out DIR]
Each fixture dir under fixtures/reviewer/ holds snapshot.md, draft.md, users.md, claude.md (items
separated by a line of `---`) and expect.json: {"findings_min": n, "kinds": [...]} or {"findings_max": 0}.
Prints per-case pass rate, mean cost and mean duration; always exits 0 (it reports, the plan reads it).
"""
import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import review  # noqa: E402

FIXTURES = HERE / "fixtures" / "reviewer"
SEP = "\n---\n"


def load_case(case_dir):
    items = lambda name: [t.strip() for t in (case_dir / name).read_text().split(SEP) if t.strip()]
    payload = review.build_input((case_dir / "snapshot.md").read_text(), (case_dir / "draft.md").read_text(),
                                 items("users.md"), items("claude.md"), final=False)
    return payload, json.loads((case_dir / "expect.json").read_text())


def meets(expect, findings):
    """True when the findings satisfy expect.json."""
    if "findings_max" in expect:
        return len(findings) <= expect["findings_max"]
    kinds = {f["kind"] for f in findings}
    return len(findings) >= expect["findings_min"] and set(expect["kinds"]) <= kinds


def run_case(case_dir, reps, run=None):
    run = run or review.run_reviewer
    payload, expect = load_case(case_dir)
    results = []
    for _ in range(reps):
        try:
            verdict = run(payload)
        except review.ReviewerUnavailable as e:
            results.append({"ok": False, "unavailable": str(e), "findings": [], "meta": {}})
            continue
        results.append({"ok": meets(expect, verdict["findings"]), "findings": verdict["findings"],
                        "meta": verdict.get("meta", {})})
    return expect, results


def mean(values):
    values = [v for v in values if v is not None]
    return sum(values) / len(values) if values else 0.0


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--case")
    ap.add_argument("--prompt", type=Path, help="reviewer prompt to use instead of reviewer_prompt.md")
    ap.add_argument("--out", type=Path, help="directory for the raw per-rep results")
    args = ap.parse_args(argv)
    if args.prompt:
        review.PROMPT = args.prompt
    cases = sorted(d for d in FIXTURES.iterdir() if d.is_dir() and (not args.case or d.name == args.case))
    total = 0.0
    for case_dir in cases:
        expect, results = run_case(case_dir, args.reps)
        passed = sum(r["ok"] for r in results)
        cost = mean(r["meta"].get("cost_usd") for r in results)
        secs = mean((r["meta"].get("duration_ms") or 0) / 1000 for r in results if r["meta"])
        total += cost * len(results)
        kinds = sorted({f["kind"] for r in results for f in r["findings"]})
        print(f"{'PASS' if passed == len(results) else 'FAIL'} {case_dir.name}: {passed}/{len(results)} "
              f"cost=${cost:.4f} dur={secs:.1f}s kinds={','.join(kinds) or '-'}")
        if args.out:
            args.out.mkdir(parents=True, exist_ok=True)
            (args.out / f"{case_dir.name}.json").write_text(json.dumps({"expect": expect, "results": results}, indent=1))
    print(f"total cost ${total:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
