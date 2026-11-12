# AI Usage

A GNOME Shell top-bar indicator that shows how much of your Claude and Codex usage limits you have used.

```
 ✳ ▰▰▰▱▱ 42%   ◎ ▰▱▱▱▱ 25%
```

- **Top bar:** for each service, a small meter and the percentage of the 5-hour limit used.
- **Popup:** a card per service with the plan name, 5-hour and weekly meters, when each window resets, and the tokens used in that window.
- **Colours:** Claude is blue and Codex is green. A meter turns amber at 60% and red at 85%, with "High" or "Near limit" written under it.
- **Light and dark:** the popup follows the OS appearance setting (Settings → Appearance) and switches as soon as you change it.

## Requirements

- GNOME Shell 3.36 (Ubuntu 20.04). Other versions are not supported.
- Claude Code and/or the Codex CLI, signed in on this machine.
- `python3`, for the token counts.
- `jq`, for the Claude offline fallback only.

## Install

```sh
./install.sh
```

The installer loads the extension into the running shell, so the indicator appears straight away. Re-run it after changing any file in `ai-usage@jeo/`; no shell restart is needed.

If the indicator does not appear:

1. Press **Alt+F2**, type `r`, press **Enter** (X11 only; on Wayland, log out and back in).
2. Run `gnome-extensions enable ai-usage@jeo`.

## Uninstall

```sh
./uninstall.sh
```

This removes the extension, its cache directory and the statusline hook described below.

## Where the numbers come from

The indicator refreshes every 2 minutes, when the popup opens (at most once per 30 seconds), and when you press **Refresh**.

| | Live source | Fallback when the live call fails |
|---|---|---|
| Claude | `api.anthropic.com/api/oauth/usage`, using the token in `~/.claude/.credentials.json` | `~/.cache/ai-usage/claude.json` |
| Codex | `chatgpt.com/backend-api/wham/usage`, using the token in `~/.codex/auth.json` | The last `rate_limits` record in the newest `~/.codex/sessions` rollout file |

When a card is showing fallback data it says `Offline · cached 5m ago`. Fallback data is only as fresh as your last use of that CLI.

Both live endpoints are undocumented and could change or stop working without notice.

### Token counts

Next to each reset time the popup shows, for example, `253K tokens · 3.8M cached`:

- **tokens** is uncached input plus output.
- **cached** is input re-read from the prompt cache, which is most of the traffic in a long session.

The counts cover the same window as the meter above them. They are added up by `tokens.py` from the session logs in `~/.claude/projects` and `~/.codex/sessions`, so they include only what was used on this computer. The percentages come from the services and include your usage everywhere.

### Statusline hook

Claude Code does not store its rate limits on disk, so the installer adds a marked block to `~/.claude/statusline-command.sh` that saves them to `~/.cache/ai-usage/claude.json` each time the statusline runs. The original script is kept as `statusline-command.sh.bak`. If the script has no `input=$(cat)` line, the installer skips this step and Claude has no offline fallback.

### Tokens

- Tokens are read from disk on every refresh and sent only to their own vendor.
- They are never refreshed, stored or logged by the extension.
- When a token expires, the card shows `Sign-in expired — open Claude Code once` (or Codex). Running that CLI renews it.

## Troubleshooting

| Symptom | What to do |
|---|---|
| No indicator after install | Follow the two steps under Install |
| Indicator shows `–` | Open the popup and read the note under the card |
| `Sign-in expired` | Run the named CLI once |
| Anything else | `journalctl -b /usr/bin/gnome-shell \| grep -i ai-usage` |

## Development

```
ai-usage@jeo/
  extension.js     panel button, popup, refresh timer
  providers.js     live fetch + fallback for each service
  tokens.py        token counts from the local session logs
  stylesheet.css   meters, cards, colour states
  icons/           panel glyphs
test/
  run-providers.js
```

Print what each provider returns, without touching the shell:

```sh
gjs test/run-providers.js            # live
gjs test/run-providers.js --offline  # forces the fallbacks
```

To change the refresh interval, colour thresholds or colours, edit the constants at the top of `ai-usage@jeo/extension.js`.
