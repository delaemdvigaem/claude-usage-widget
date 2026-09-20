#!/usr/bin/env bash
# Loads the installed extension in an isolated headless GNOME Shell (own D-Bus
# session and Wayland socket, the real session is untouched) and takes
# screenshots of the live numbers and of fixture states built from them.
# Other UI language: LC_ALL=en_US.UTF-8 LANGUAGE= tools/headless-test.sh [out-subdir]
# Usage: ./install.sh && tools/headless-test.sh   → out/test/*.png, out/test/shell.log
set -euo pipefail

if [[ -z "${CU_INNER:-}" ]]; then
    exec env CU_INNER=1 timeout 90 dbus-run-session -- "$0" "$@"
fi

UUID="claude-usage@delaemdvigaem.github.io"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/out/${1:-test}"
mkdir -p "$OUT"
export CLAUDE_USAGE_FILE="$OUT/fixture.json"
BASE="$OUT/base.json"
cp "${XDG_CACHE_HOME:-$HOME/.cache}/claude-usage.json" "$BASE"

fixture() {  # builds a state from the live data and swaps it in atomically, like the poller
    python3 - "$BASE" "$CLAUDE_USAGE_FILE" "$1" <<'PY'
import json, os, sys
from datetime import datetime, timedelta, timezone
base, path, state = sys.argv[1:]
d = json.load(open(base))
now = datetime.now(timezone.utc)
d.update(ok=True, error=None, fetched_at=now.isoformat(), data_at=now.isoformat())
session, week, model = d['limits'][:3]
if state == 'calm':
    for limit in d['limits']:
        limit['severity'] = 'normal'
elif state == 'critical':
    week.update(percent=93, severity='critical')
elif state == 'reset':
    session.update(percent=0, severity='normal')
elif state == 'blip':      # one failed poll: nothing to report yet
    d.update(ok=False, error='unavailable', data_at=(now - timedelta(minutes=3)).isoformat())
elif state == 'down':      # failing for a while
    d.update(ok=False, error='unavailable', data_at=(now - timedelta(minutes=30)).isoformat())
elif state == 'expired':
    d.update(ok=False, error='token_expired')
    session.update(percent=42, severity='normal')
    week.update(percent=93, severity='critical')
    model.update(percent=100, severity='warning')
json.dump(d, open(path + '.tmp', 'w'), ensure_ascii=False, indent=1)
os.replace(path + '.tmp', path)
PY
}

fixture live
gnome-shell --headless --wayland --no-x11 --wayland-display wayland-cu-test \
    --virtual-monitor 1920x1080 > "$OUT/shell.log" 2>&1 &
SHELL_PID=$!
trap 'kill $SHELL_PID 2>/dev/null || true' EXIT
sleep 7

# the shell starts in the overview, where the desktop background is hidden
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
    --method org.freedesktop.DBus.Properties.Set org.gnome.Shell OverviewActive '<false>' > /dev/null
sleep 3

n=1
for state in live calm critical reset blip down expired; do
    fixture "$state"
    sleep 2
    gjs -m "$ROOT/tools/shot.js" "$OUT/$n-$state.png"
    n=$((n + 1))
done

gdbus call --session --dest org.gnome.Shell.Extensions --object-path /org/gnome/Shell/Extensions \
    --method org.gnome.Shell.Extensions.GetExtensionInfo "$UUID" | tr ',' '\n' | grep -E "'(state|error)'"

echo "--- warnings/errors in shell.log:"
grep -i -E "claude|JS ERROR|warning|critical" "$OUT/shell.log" || echo "(none)"
