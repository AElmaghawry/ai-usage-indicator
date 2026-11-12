#!/bin/sh
set -e

UUID="ai-usage@jeo"
STATUSLINE="$HOME/.claude/statusline-command.sh"

gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/ai-usage"

if [ -f "$STATUSLINE" ] && grep -q 'ai-usage-indicator' "$STATUSLINE"; then
    sed -i '/^# >>> ai-usage-indicator$/,/^# <<< ai-usage-indicator$/d' "$STATUSLINE"
    echo "Removed statusline hook from $STATUSLINE"
fi
echo "Uninstalled $UUID"
