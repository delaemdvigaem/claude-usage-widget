#!/usr/bin/env python3
"""Claude Usage Widget poller.

Fetches subscription limits from the (undocumented) Claude OAuth usage endpoint
and writes a normalized snapshot to ~/.cache/claude-usage.json, which the GNOME
Shell extension watches. Run by a systemd user timer every 3 minutes.

The access token is read from Claude Code's credentials file; it is never
refreshed here (Claude Code does that itself). On any failure the last known
limits are kept and only the status fields change.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
CREDENTIALS = os.path.expanduser('~/.claude/.credentials.json')
CACHE_DIR = os.environ.get('XDG_CACHE_HOME') or os.path.expanduser('~/.cache')
OUT_FILE = os.path.join(CACHE_DIR, 'claude-usage.json')
FALLBACK_VERSION = '2.1.278'
MIN_INTERVAL = 170  # seconds; the endpoint must not be polled more often than every 3 min
VERSION_RE = re.compile(r'\d+\.\d+\.\d+')


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def claude_code_version():
    """User-Agent must look like claude-code/<version>, otherwise the API answers 429."""
    exe = shutil.which('claude') or os.path.expanduser('~/.local/bin/claude')
    try:
        m = VERSION_RE.fullmatch(os.path.basename(os.path.realpath(exe)))
        if m:
            return m.group(0)
        out = subprocess.run([exe, '--version'], capture_output=True, text=True, timeout=10).stdout
        m = VERSION_RE.search(out)
        if m:
            return m.group(0)
    except (OSError, subprocess.SubprocessError):
        pass
    return FALLBACK_VERSION


def read_previous():
    try:
        with open(OUT_FILE, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def write_snapshot(snapshot):
    os.makedirs(CACHE_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix='.claude-usage.', dir=CACHE_DIR)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        json.dump(snapshot, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT_FILE)


def normalize(raw):
    limits = []
    for item in raw.get('limits') or []:
        scope = item.get('scope') or {}
        model = (scope.get('model') or {}).get('display_name')
        limits.append({
            'kind': item.get('kind'),
            'percent': item.get('percent'),
            'severity': item.get('severity'),
            'resets_at': item.get('resets_at'),
            'model': model,
            'is_active': bool(item.get('is_active')),
        })
    if limits:
        return limits

    # Older response shape without limits[]
    for key, kind, model in (
        ('five_hour', 'session', None),
        ('seven_day', 'weekly_all', None),
        ('seven_day_opus', 'weekly_scoped', 'Opus'),
        ('seven_day_sonnet', 'weekly_scoped', 'Sonnet'),
    ):
        item = raw.get(key)
        if item and item.get('utilization') is not None:
            limits.append({
                'kind': kind,
                'percent': item['utilization'],
                'severity': None,
                'resets_at': item.get('resets_at'),
                'model': model,
                'is_active': False,
            })
    return limits


def fetch():
    """Returns (limits, error_code)."""
    try:
        with open(CREDENTIALS, encoding='utf-8') as f:
            oauth = json.load(f)['claudeAiOauth']
        token = oauth['accessToken']
    except (OSError, ValueError, KeyError):
        return None, 'no_credentials'

    expires_at = oauth.get('expiresAt')
    if expires_at and expires_at / 1000 < time.time():
        return None, 'token_expired'

    req = urllib.request.Request(USAGE_URL, headers={
        'Authorization': f'Bearer {token}',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': f'claude-code/{claude_code_version()}',
        'Accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = json.load(resp)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return None, 'token_expired'
        if e.code == 429:
            return None, 'rate_limited'
        return None, f'http_{e.code}'
    except (urllib.error.URLError, OSError, ValueError):
        return None, 'unavailable'

    limits = normalize(raw)
    if not limits:
        return None, 'bad_response'
    return limits, None


def main():
    force = '--force' in sys.argv[1:]
    prev = read_previous()

    try:
        last = datetime.fromisoformat(prev['fetched_at']).timestamp()
    except (KeyError, TypeError, ValueError):
        last = 0
    if not force and 0 <= time.time() - last < MIN_INTERVAL:
        return 0

    limits, error = fetch()
    now = now_iso()
    snapshot = {
        'version': 1,
        'fetched_at': now,
        'ok': error is None,
        'error': error,
        'data_at': now if error is None else prev.get('data_at'),
        'limits': limits if error is None else prev.get('limits') or [],
    }
    write_snapshot(snapshot)
    if error:
        print(f'claude-usage-poller: {error}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
