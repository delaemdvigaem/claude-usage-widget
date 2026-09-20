#!/usr/bin/env bash
# Installs the extension and the poller timer for the current user. No root needed.
set -euo pipefail

UUID="claude-usage@delaemdvigaem.github.io"
SRC="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$UUID"
UNIT_DIR="$HOME/.config/systemd/user"

mkdir -p "$EXT_DIR" "$UNIT_DIR"
cp "$SRC/extension/$UUID/"* "$EXT_DIR/"
chmod +x "$EXT_DIR/poller.py"
cp "$SRC"/systemd/claude-usage-poller.{service,timer} "$UNIT_DIR/"

systemctl --user daemon-reload
systemctl --user enable --now claude-usage-poller.timer
systemctl --user start claude-usage-poller.service

# A running shell only learns about new extensions after re-login (Wayland),
# so `gnome-extensions enable` may fail here; fall back to the setting itself.
if ! gnome-extensions enable "$UUID" 2>/dev/null; then
    current="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "$current" != *"'$UUID'"* ]]; then
        if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
            gsettings set org.gnome.shell enabled-extensions "['$UUID']"
        else
            gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']"
        fi
    fi
fi

echo "Installed to $EXT_DIR"
echo "Log out and back in to load the widget."
