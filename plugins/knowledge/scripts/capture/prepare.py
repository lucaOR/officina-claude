"""Build the text the learning extractor reads: a handoff note or a filtered transcript."""
import json
from pathlib import Path

USER_CAP = 1500
ASSISTANT_CAP = 400
TAIL_CHARS = 12000


def _user_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _filter(transcript_path):
    out, tools = [], []

    def flush():
        if tools:
            out.append("TOOLS: " + ", ".join(tools))
            tools.clear()

    try:
        lines = Path(transcript_path).read_text(errors="replace").splitlines()
    except OSError:
        return ""
    for raw in lines:
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(obj, dict) or obj.get("isSidechain") or obj.get("isMeta"):
            continue
        msg = obj.get("message")
        if not isinstance(msg, dict):
            continue
        kind = obj.get("type")
        content = msg.get("content")
        if kind == "user":
            text = _user_text(content).strip()
            if not text or text.startswith("<"):
                continue
            flush()
            out.append("USER: " + text[:USER_CAP])
        elif kind == "assistant":
            blocks = content if isinstance(content, list) else []
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                if b.get("type") == "text" and b.get("text", "").strip():
                    flush()
                    out.append("ASSISTANT: " + b["text"].strip()[:ASSISTANT_CAP])
                elif b.get("type") == "tool_use":
                    tools.append(str(b.get("name", "?")))
    flush()
    return "\n".join(out)


def prepare_input(transcript_path, handoff_path, mode):
    """Return (effective_mode, text). mode is 'auto', 'handoff' or 'transcript'."""
    have_note = handoff_path is not None and Path(handoff_path).is_file()
    effective = mode
    if mode == "auto":
        effective = "handoff" if have_note else "transcript"
    elif mode == "handoff" and not have_note:
        effective = "transcript"
    filtered = _filter(transcript_path)
    if effective == "handoff":
        note = Path(handoff_path).read_text(errors="replace")
        return "handoff", "NOTE:\n" + note + "\nTRANSCRIPT TAIL:\n" + filtered[-TAIL_CHARS:]
    return "transcript", filtered
