# AI Usage — Claude & Codex limits in your top bar

Stop guessing how much of your Claude or Codex limit is left.
This small GNOME extension puts it right in your top bar:

```
 ✳ ▰▰▰▱▱ 42%   ◎ ▰▱▱▱▱ 25%
```

- **✳ Claude** (blue) and **◎ Codex** (green), side by side.
- The bar fills as you use your 5-hour limit.
- It turns **amber at 60%** and **red at 85%**, so you notice before you hit the wall.
- Click it to see your weekly limit, when each limit resets, and how many tokens you've used.
- Works in light and dark mode.

## What you need

- **Ubuntu 20.04** (GNOME Shell 3.36). Other versions are not tested yet.
- **Claude Code** and/or the **Codex CLI**, already signed in on this computer.
- `python3` and `jq` (most systems already have them; if not: `sudo apt install python3 jq`).

## Install (1 minute)

```sh
git clone https://github.com/AElmaghawry/ai-usage-indicator.git
cd ai-usage-indicator
./install.sh
```

The indicator should appear in your top bar right away.

**Don't see it?**
1. Press **Alt+F2**, type `r`, press **Enter** (on Wayland: log out and back in).
2. Run `gnome-extensions enable ai-usage@jeo`.

## Uninstall

```sh
./uninstall.sh
```

This removes everything the installer added.

## Is it safe?

- It only **reads** the sign-in files that Claude Code and Codex already keep on your computer.
- Your Claude login is sent only to Anthropic, and your Codex login only to OpenAI — nowhere else.
- Nothing is saved, logged, or shared.

## Good to know

- It refreshes every 2 minutes, or when you click **Refresh**.
- If it can't reach the internet, it shows the last numbers it saw and says "Offline".
- It uses unofficial endpoints, so an update from Anthropic or OpenAI could break it. If that happens, please open an issue.

## Something wrong?

| Problem | Fix |
|---|---|
| No icon after install | Follow the "Don't see it?" steps above |
| Shows `–` | Click it and read the message under the card |
| Says "Sign-in expired" | Open Claude Code (or Codex) once, then refresh |

Still stuck? [Open an issue](https://github.com/AElmaghawry/ai-usage-indicator/issues).

## Want the details?

How it works, where the numbers come from, and how to change colours or timing: see [TECHNICAL.md](TECHNICAL.md).

## Like it?

Give it a ⭐ — it helps other people find it.

## License

MIT — free to use, change, and share.
