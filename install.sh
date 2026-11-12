#!/bin/sh
# Installs the AI Usage GNOME Shell extension for the current user. Safe to re-run.
set -e

UUID="ai-usage@jeo"
SRC="$(cd "$(dirname "$0")" && pwd)/$UUID"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
STATUSLINE="$HOME/.claude/statusline-command.sh"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/ai-usage"

mkdir -p "$DEST" "$CACHE_DIR"
rm -rf "$DEST"
cp -r "$SRC" "$DEST"
echo "Installed to $DEST"

# Offline fallback for Claude: have the statusline save the rate limits it is given.
if [ -f "$STATUSLINE" ] && ! grep -q 'ai-usage-indicator' "$STATUSLINE"; then
    if grep -q '^input=\$(cat)' "$STATUSLINE"; then
        cp "$STATUSLINE" "$STATUSLINE.bak"
        awk '
            { print }
            /^input=\$\(cat\)/ && !done {
                print "# >>> ai-usage-indicator"
                print "aiu_rl=$(echo \"$input\" | jq -c \".rate_limits // empty\" 2>/dev/null)"
                print "[ -n \"$aiu_rl\" ] && mkdir -p \"${XDG_CACHE_HOME:-$HOME/.cache}/ai-usage\" && printf \"%s\\n\" \"$aiu_rl\" > \"${XDG_CACHE_HOME:-$HOME/.cache}/ai-usage/claude.json\""
                print "# <<< ai-usage-indicator"
                done = 1
            }
        ' "$STATUSLINE.bak" > "$STATUSLINE"
        echo "Patched $STATUSLINE (backup: $STATUSLINE.bak)"
    else
        echo "Skipped statusline patch: no 'input=\$(cat)' line in $STATUSLINE"
    fi
fi

# A running shell only scans for extensions at startup and caches their code by path,
# so hand it a fresh copy under a new path. The copy in $DEST is what loads at next login.
STAMP="r$(date +%s)"
# (getCurrentExtension() only recognises paths containing /gnome-shell/extensions/.)
LIVE="$CACHE_DIR/gnome-shell/extensions"
rm -rf "$CACHE_DIR/gnome-shell"
mkdir -p "$LIVE/$STAMP"
cp -r "$SRC" "$LIVE/$STAMP/$UUID"
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval \
    "(function(){const M=imports.ui.main.extensionManager;const U=imports.misc.extensionUtils;const old=M.lookup('$UUID');if(old)M.unloadExtension(old);M._unloadedExtensions.delete('$UUID');const orig=U.installImporter;U.installImporter=function(e){const sp=imports.searchPath.slice();imports.searchPath=['$LIVE'];try{e.imports=imports['$STAMP']['$UUID'];}finally{imports.searchPath=sp;}};try{M.loadExtension(M.createExtensionObject('$UUID',imports.gi.Gio.File.new_for_path('$LIVE/$STAMP/$UUID'),U.ExtensionType.PER_USER));}finally{U.installImporter=orig;}})()" \
    >/dev/null 2>&1 || true

if gnome-extensions enable "$UUID" 2>/dev/null && gnome-extensions info "$UUID" >/dev/null 2>&1; then
    echo "Enabled and loaded into the running shell."
else
    echo "Reload GNOME Shell so it sees the extension (Alt+F2, r, Enter), then run:"
    echo "  gnome-extensions enable $UUID"
fi
