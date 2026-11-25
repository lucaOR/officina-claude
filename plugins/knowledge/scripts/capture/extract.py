"""Run the Haiku extractor over prepared text and keep only verifiable rows."""
import json
import os
import subprocess
from pathlib import Path

MAX_ROWS = 6
MAX_INPUT_CHARS = 30000
TIMEOUT = 150
KEYS = ("statement", "quote", "kind", "scope_guess", "theme")
PROMPT = Path(__file__).with_name("prompt.txt")


def _norm(s):
    return " ".join(s.split())


def _first_list(out):
    dec = json.JSONDecoder()
    i = out.find("[")
    while i != -1:
        try:
            val, _ = dec.raw_decode(out, i)
        except ValueError:
            val = None
        if isinstance(val, list):
            return val
        i = out.find("[", i + 1)
    return []


def extract(text, vocab, *, runner=subprocess.run):
    try:
        text = text[-MAX_INPUT_CHARS:]
        stdin = (PROMPT.read_text().rstrip("\n") + "\nKNOWN THEMES: "
                 + ", ".join(vocab) + "\n" + text)
        env = dict(os.environ, KNOWLEDGE_EXTRACT="1")
        proc = runner(["claude", "-p", "--model", "haiku", "--tools", ""],
                      input=stdin, capture_output=True, text=True,
                      timeout=TIMEOUT, env=env)
        if proc.returncode != 0:
            return []
        source = _norm(text)
        rows = []
        for r in _first_list(proc.stdout):
            if not isinstance(r, dict) or not all(isinstance(r.get(k), str) for k in KEYS):
                continue
            q = _norm(r["quote"])
            if q and q in source:
                rows.append({k: r[k] for k in KEYS})
        return rows[:MAX_ROWS]
    except Exception:
        return []
