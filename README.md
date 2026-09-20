# Claude Usage Widget

GNOME Shell extension that shows your Claude subscription limits (5-hour session, weekly, per-model) as a live widget **on the desktop background** — under all windows, always visible. Works on GNOME 50 Wayland; needs nothing installed system-wide.

Виджет остатков лимитов Claude на рабочем столе GNOME. Авторизация: автоматически из установленного Claude Code или вход через Claude (OAuth).

## Status: MVP

- `extension/claude-usage@delaemdvigaem.github.io/` — the extension (GNOME Shell 49–50). Puts a widget into the desktop background layer: three bars (5-hour session, week, week for the busiest model) with percent, time until reset and colour by severity.
- `extension/…/poller.py` — stdlib-only Python poller. Reads the Claude Code token from `~/.claude/.credentials.json`, asks the usage endpoint and writes `~/.cache/claude-usage.json`; the extension watches that file. On errors the last known values stay on screen with a note (token expired / service unavailable).
- `systemd/` — user timer that runs the poller every 3 minutes.

## Install

```sh
./install.sh
```

Then log out and back in (on Wayland a running shell does not pick up new extensions). No root needed. Requires Claude Code to be signed in.

Logs: `journalctl --user -o cat /usr/bin/gnome-shell` (extension), `journalctl --user -u claude-usage-poller` (poller).

## Development

`./install.sh && tools/headless-test.sh` loads the extension in an isolated headless GNOME Shell (no logout needed) and writes screenshots of three states plus the shell log to `out/test/`.

Clawd in the widget header is redrawn from the pixel art Claude Code shows in the terminal. Claude and Clawd belong to Anthropic; this project is not affiliated with Anthropic.
