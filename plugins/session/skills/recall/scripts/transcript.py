"""Read Claude Code transcripts into what /session:recall archives and indexes.

The transcript format is undocumented and changes between Claude Code versions, so this keeps
the entry and block types it knows and skips everything else without error. A malformed line
is dropped, never raised.

Positions are indexes into the filtered entry list, which is exactly the archived file, so a
row's position finds its exchange again in the archive.
"""
import gzip
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "lib"))
from lineage import parent_from_prompt  # noqa: E402

CUT = 2048
SKIP_MARK = "[recall:skip]"
# Everything a person would read in the conversation. The rest (api-request blobs, attachments,
# file-history snapshots, mode switches) is bookkeeping and most of a transcript's bytes.
KEEP_TYPES = ("user", "assistant", "system", "summary", "custom-title", "ai-title")
# A copy of the tool result the message content already holds, kept for the UI.
DROP_FIELDS = ("toolUseResult",)
WRAPPERS = ("<command-name>", "<command-message>", "<command-args>", "<local-command-",
            "<task-notification>")
COMMAND_ARGS = re.compile(r"<command-args>(.*?)</command-args>", re.S)
# What the main session wraps around the excerpts it relays, so they are not found again.
RELAYED = re.compile(r"\[recall excerpts\].*?(?:\[end recall excerpts\]|\Z)", re.S)
REMINDER = re.compile(r"<system-reminder>.*?</system-reminder>", re.S)


def read_entries(path: Path):
    """Yield each JSON object of a .jsonl or .jsonl.gz file, skipping malformed lines."""
    opener = gzip.open if str(path).endswith(".gz") else open
    try:
        with opener(path, "rb") as fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                if isinstance(entry, dict):
                    yield entry
    except (OSError, EOFError):
        return


def keep(entries):
    """The archive filter: conversation entries only, minus duplicated payloads."""
    kept = []
    for e in entries:
        if e.get("type") in KEEP_TYPES or queued_attachment(e) is not None:
            kept.append({k: v for k, v in e.items() if k not in DROP_FIELDS})
    return kept


def queued_attachment(entry):
    """The attachment of a message typed while Claude was working, else None.

    That message is recorded only as an attachment of subtype queued_command, so the archive
    keeps these and no other attachment.
    """
    att = entry.get("attachment")
    if entry.get("type") == "attachment" and isinstance(att, dict) \
            and att.get("type") == "queued_command":
        return att
    return None


def content_of(entry):
    msg = entry.get("message")
    return msg.get("content") if isinstance(msg, dict) else None


def text_of(content):
    """The text of a str or a list of blocks, ignoring images and other non-text blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


def real_prompt(entry):
    """The text a person typed, or None for meta entries, wrappers and tool results."""
    att = queued_attachment(entry)
    if att is not None:
        origin = att.get("origin")
        kind = origin.get("kind") if isinstance(origin, dict) else None
        if att.get("isMeta") or kind not in (None, "human"):
            return None     # a peer message or a task notification, not something typed
        content = att.get("prompt")
    elif entry.get("type") != "user" or entry.get("isMeta"):
        return None
    else:
        content = content_of(entry)
    if isinstance(content, list):
        content = [b for b in content if isinstance(b, dict) and b.get("type") == "text"]
        if not content:
            return None
    text = REMINDER.sub("", text_of(content)).strip()
    if text.startswith(("<command-message>", "<command-name>")):
        m = COMMAND_ARGS.search(text)       # a slash command's arguments are what was typed
        text = m.group(1).strip() if m else ""
    elif text.startswith(WRAPPERS):
        return None
    return text or None


def is_recall_call(block):
    """A tool call that runs /session:recall itself, whose hits would echo back as new hits."""
    if not isinstance(block, dict) or block.get("type") != "tool_use":
        return False
    args = block.get("input") if isinstance(block.get("input"), dict) else {}
    name = block.get("name")
    if name in ("Agent", "Task"):
        return str(args.get("subagent_type", "")).split(":")[-1] == "recall" \
            or str(args.get("prompt", "")).startswith("RECALL v1")
    if name == "Skill":
        return args.get("skill") == "session:recall"
    if name == "Bash":
        return re.search(r"recall\.py\s+(search|show)\b", str(args.get("command", ""))) is not None
    return False


def rows(kept, subagent=None):
    """Index rows (role, position, timestamp, body) for every searchable block.

    Recall's own calls and their results are left out, so one recall never finds the
    excerpts an earlier recall printed.
    """
    out = []
    echo = {b.get("id") for e in kept if e.get("type") == "assistant"
            for b in (content_of(e) if isinstance(content_of(e), list) else ()) if is_recall_call(b)}
    for i, e in enumerate(kept):
        pos = f"{subagent}:{i}" if subagent else str(i)
        ts = e.get("timestamp") or ""
        found = []
        if e.get("type") == "attachment":
            prompt = real_prompt(e)
            if prompt:
                found.append(("user", prompt))
        elif e.get("type") == "user":
            prompt = real_prompt(e)
            if prompt:
                found.append(("user", prompt))
            content = content_of(e)
            for b in content if isinstance(content, list) else ():
                if isinstance(b, dict) and b.get("type") == "tool_result" \
                        and b.get("tool_use_id") not in echo:
                    found.append(("tool_result", text_of(b.get("content"))[:CUT]))
        elif e.get("type") == "assistant":
            content = content_of(e)
            for b in content if isinstance(content, list) else ():
                if not isinstance(b, dict) or is_recall_call(b):
                    continue
                if b.get("type") == "text":
                    found.append(("assistant", RELAYED.sub("", b.get("text", "")).strip()))
                elif b.get("type") == "tool_use":
                    body = f"{b.get('name', '')} {json.dumps(b.get('input'), ensure_ascii=False)}"
                    found.append(("tool_use", body[:CUT]))
        for role, body in found:
            if body.strip():
                out.append(("subagent" if subagent else role, pos, ts, body))
    return out


def meta(kept):
    """started, ended, parent (from the first real prompt), title and the skip flag."""
    stamps = [e["timestamp"] for e in kept if e.get("timestamp")]
    prompts = [p for p in (real_prompt(e) for e in kept) if p]
    custom = [e["customTitle"] for e in kept if e.get("type") == "custom-title" and e.get("customTitle")]
    generated = [e["aiTitle"] for e in kept if e.get("type") == "ai-title" and e.get("aiTitle")]
    return {
        "started": min(stamps) if stamps else None,
        "ended": max(stamps) if stamps else None,
        "parent": parent_from_prompt(prompts[0]) if prompts else None,
        "title": (custom or generated or [None])[-1],
        "skip": any(SKIP_MARK in p for p in prompts),
    }
