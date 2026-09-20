#!/usr/bin/env bash
# Loads the installed extension in an isolated headless GNOME Shell (own D-Bus
# session and Wayland socket, the real session is untouched) and takes
# screenshots of three states: live data, "limit just reset", "token expired".
# Usage: ./install.sh && tools/headless-test.sh   → out/test/*.png, out/test/shell.log
set -euo pipefail

if [[ -z "${CU_INNER:-}" ]]; then
    exec env CU_INNER=1 timeout 90 dbus-run-session -- "$0" "$@"
fi

UUID="claude-usage@delaemdvigaem.github.io"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/out/test"
mkdir -p "$OUT"
export CLAUDE_USAGE_FILE="$OUT/fixture.json"
cp "${XDG_CACHE_HOME:-$HOME/.cache}/claude-usage.json" "$CLAUDE_USAGE_FILE"

fixture() {  # atomically rewrites the fixture the way the poller does
    python3 - "$CLAUDE_USAGE_FILE" "$1" <<'PY'
import json, os, sys
path, state = sys.argv[1:]
d = json.load(open(path))
if state == 'reset':
    d['limits'][0].update(percent=0, severity='normal')
else:
    d.update(ok=False, error='token_expired')
    d['limits'][0].update(percent=42, severity='normal')
    d['limits'][1].update(percent=93, severity='critical')
    d['limits'][2].update(percent=100, severity='warning')
json.dump(d, open(path + '.tmp', 'w'), ensure_ascii=False, indent=1)
os.replace(path + '.tmp', path)
PY
}

gnome-shell --headless --wayland --no-x11 --wayland-display wayland-cu-test \
    --virtual-monitor 1920x1080 > "$OUT/shell.log" 2>&1 &
SHELL_PID=$!
trap 'kill $SHELL_PID 2>/dev/null || true' EXIT
sleep 7

# the shell starts in the overview, where the desktop background is hidden
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.freedesktop.DBus.Properties.Set org.gnome.Shell OverviewActive '<false>' > /dev/null
sleep 3

gjs -m "$ROOT/tools/shot.js" "$OUT/1-live.png"
fixture reset;   sleep 2; gjs -m "$ROOT/tools/shot.js" "$OUT/2-reset.png"
fixture expired; sleep 2; gjs -m "$ROOT/tools/shot.js" "$OUT/3-expired.png"

gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.GetExtensionInfo "$UUID" | tr ',' '\n' | grep -E "'(state|error)'"

echo "--- warnings/errors in shell.log:"
grep -i -E "claude|JS ERROR|warning|critical" "$OUT/shell.log" || echo "(none)"
