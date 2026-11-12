#!/usr/bin/env python3
"""Count tokens in the local Claude Code and Codex session logs.

Usage: tokens.py CLAUDE_5H CLAUDE_7D CODEX_5H CODEX_7D
Each argument is the unix time a limit window started. Prints JSON:
  {"claude": {"session": {"fresh": n, "cached": n}, "weekly": {...}}, "codex": {...}}
"fresh" is uncached input + output; "cached" is input served from the prompt cache.
Runs as a subprocess so that parsing the logs never blocks GNOME Shell.
"""
import calendar
import glob
import json
import os
import sys
import time

HOME = os.path.expanduser("~")
CLAUDE_LOGS = os.path.join(HOME, ".claude", "projects", "**", "*.jsonl")
CODEX_LOGS = os.path.join(HOME, ".codex", "sessions", "**", "*.jsonl")


def epoch(ts):
    try:
        return calendar.timegm(time.strptime(ts[:19], "%Y-%m-%dT%H:%M:%S"))
    except (TypeError, ValueError):
        return None


def recent(pattern, since):
    for path in glob.iglob(pattern, recursive=True):
        try:
            if os.path.getmtime(path) >= since:
                yield path
        except OSError:
            pass


def lines(path, needle):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if needle in line:
                    try:
                        yield json.loads(line)
                    except ValueError:
                        pass
    except OSError:
        pass


def claude_events(since):
    # One response is logged once per content block with the same usage; keep the last.
    seen = {}
    for path in recent(CLAUDE_LOGS, since):
        for rec in lines(path, '"usage"'):
            msg = rec.get("message")
            if not isinstance(msg, dict) or not isinstance(msg.get("usage"), dict):
                continue
            t = epoch(rec.get("timestamp"))
            if t is None:
                continue
            u = msg["usage"]
            fresh = ((u.get("input_tokens") or 0) + (u.get("cache_creation_input_tokens") or 0)
                     + (u.get("output_tokens") or 0))
            key = (msg.get("id"), rec.get("requestId")) if msg.get("id") else (path, len(seen))
            seen[key] = (t, fresh, u.get("cache_read_input_tokens") or 0)
    return seen.values()


def codex_events(since):
    for path in recent(CODEX_LOGS, since):
        prev_total = None
        for rec in lines(path, '"token_count"'):
            info = (rec.get("payload") or {}).get("info") or {}
            total = (info.get("total_token_usage") or {}).get("total_tokens")
            last = info.get("last_token_usage")
            # The same count is re-emitted between turns; only a changed total is new usage.
            if total is None or total == prev_total or not isinstance(last, dict):
                continue
            prev_total = total
            t = epoch(rec.get("timestamp"))
            if t is None:
                continue
            cached = last.get("cached_input_tokens") or 0
            fresh = (last.get("input_tokens") or 0) - cached + (last.get("output_tokens") or 0)
            yield (t, max(0, fresh), cached)


def totals(events, starts):
    out = [{"fresh": 0, "cached": 0} for _ in starts]
    for t, fresh, cached in events:
        for bucket, start in zip(out, starts):
            if t >= start:
                bucket["fresh"] += fresh
                bucket["cached"] += cached
    return {"session": out[0], "weekly": out[1]}


def main():
    c5, c7, x5, x7 = (int(float(a)) for a in sys.argv[1:5])
    print(json.dumps({
        "claude": totals(claude_events(min(c5, c7)), (c5, c7)),
        "codex": totals(codex_events(min(x5, x7)), (x5, x7)),
    }))


if __name__ == "__main__":
    main()
