"""Shared helper: read a session's /rename title from its transcript.

`/rename` appends `{"type":"custom-title","customTitle":...}` to the session's JSONL, and a later
rename appends another, so the last record wins. A /clear mints a new session with an empty
transcript, which is why the title is lost and why the hooks that carry it forward read the
parent's file. Sibling transcripts share one directory, so the parent's path is derived from the
current session's `transcript_path` rather than from a re-implemented cwd sanitiser.
"""
import json
from pathlib import Path

_MARKER = b'"custom-title"'


def parent_transcript(transcript_path: str, parent_id: str) -> Path:
    return Path(transcript_path).parent / f"{parent_id}.jsonl"


def last_title(transcript: Path) -> str | None:
    title = None
    try:
        with open(transcript, "rb") as fh:
            for line in fh:
                if _MARKER not in line:
                    continue                       # byte test first: transcripts run to tens of MB
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if rec.get("type") == "custom-title" and rec.get("customTitle"):
                    title = rec["customTitle"]
    except OSError:
        return None
    return title
