#!/usr/bin/env python3
"""Take scans the linked phone sent, into the folder she picked on the phone.

Run by launchd (com.nanobotco.scanner-pull) every minute.

  Catalog         ~/Desktop/catalog/inbox/scans/
  Legal Cases     ~/Desktop/Legal Cases/_scans/
  a project       ~/Developer/claude code projects/<name>/_incoming/scans/
                  (kept out of git through .git/info/exclude before anything lands)
  cards           ~/Desktop/CARD DROP/, then `cards` reads them into Contacts,
                  one card per run so front and back stay together

Each file is written, its size checked, then removed from the drop
(scanner-drop Worker). Ledger: ~/.claude/state/scans.tsv. The folder list the
phone shows is sent up whenever it changes, most recently worked-on first.
"""
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.parse
import urllib.request

DROP = 'https://scanner-drop.nanobotco.workers.dev'
HOME = pathlib.Path.home()
KEY = (HOME / '.tokens' / 'SCANNER_DROP_KEY').read_text().strip()
PROJECTS = HOME / 'Developer' / 'claude code projects'
CATALOG = HOME / 'Desktop' / 'catalog' / 'inbox' / 'scans'
PINNED = [
    ('catalog', 'Catalog', CATALOG),
    ('legal', 'Legal Cases', HOME / 'Desktop' / 'Legal Cases' / '_scans'),
]
CARD_DROP = HOME / 'Desktop' / 'CARD DROP'
CARDS = HOME / '.claude' / 'bin' / 'cards'
STATE = HOME / '.claude' / 'state'
LEDGER = STATE / 'scans.tsv'
SENT = STATE / 'scan-dests.sha'
QUIET = 20  # seconds since a group's last file, so a card's back has arrived with its front
EXT = {'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png'}


def call(method, path, body=None, ctype=None):
    h = {'X-Key': KEY, 'User-Agent': 'scanner-pull'}
    if ctype:
        h['Content-Type'] = ctype
    req = urllib.request.Request(DROP + path, data=body, method=method, headers=h)
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def projects():
    out = []
    for p in PROJECTS.iterdir():
        if not p.is_dir() or p.name.startswith('.'):
            continue
        t = p.stat().st_mtime
        for f in ('.git/index', '.git/HEAD', 'CLAUDE.md'):
            try:
                t = max(t, (p / f).stat().st_mtime)
            except OSError:
                pass
        out.append((t, p.name))
    return [n for _, n in sorted(out, reverse=True)]


def send_dests():
    dests = [{'k': k, 'l': label} for k, label, _ in PINNED]
    dests += [{'k': 'p:' + n, 'l': n} for n in projects()]
    body = json.dumps(dests, ensure_ascii=False).encode()
    sha = hashlib.sha256(body).hexdigest()
    if SENT.exists() and SENT.read_text() == sha:
        return
    call('PUT', '/dests', body, 'application/json')
    SENT.write_text(sha)


def kept_out_of_git(repo):
    """True when nothing under _incoming/scans/ can be committed from this repo."""
    inside = subprocess.run(['git', '-C', str(repo), 'rev-parse', '--is-inside-work-tree'],
                            capture_output=True, text=True).stdout.strip() == 'true'
    if not inside:
        return True
    probe = '_incoming/scans/probe.pdf'
    ok = lambda: subprocess.run(['git', '-C', str(repo), 'check-ignore', '-q', probe]).returncode == 0
    if ok():
        return True
    ex = repo / '.git' / 'info' / 'exclude'
    ex.parent.mkdir(parents=True, exist_ok=True)
    with ex.open('a') as f:
        f.write('\n# scans from the phone (scanner-pull)\n/_incoming/scans/\n')
    return ok()


def folder(dest):
    for k, label, path in PINNED:
        if dest == k:
            return label, path
    if dest.startswith('p:'):
        name = dest[2:]
        repo = PROJECTS / name
        if '/' not in name and name not in ('', '.', '..') and repo.is_dir():
            if kept_out_of_git(repo):
                return name, repo / '_incoming' / 'scans'
            return 'Catalog (' + name + ')', CATALOG / name
    return 'Catalog', CATALOG


def clean(name, ctype):
    name = (name or '').replace('/', '-').replace('\\', '-').strip(' .')
    name = re.sub(r'[\x00-\x1f]', '', name)[:120] or 'scan'
    ext = EXT.get(ctype, '')
    if ext and not name.lower().endswith(ext):
        name += ext
    return name


def free(path):
    stem, ext, n = path.stem, path.suffix, 2
    while path.exists():
        path = path.with_name(f'{stem} {n}{ext}')
        n += 1
    return path


def land(o, folder_path, name):
    data = call('GET', '/get/' + o['id'])
    if len(data) != o['size']:
        raise IOError(f"{o['id']}: {len(data)} bytes, expected {o['size']}")
    folder_path.mkdir(parents=True, exist_ok=True)
    path = free(folder_path / name)
    tmp = path.with_name(path.name + '.part')
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return path


def log(*cols):
    STATE.mkdir(parents=True, exist_ok=True)
    new = not LEDGER.exists()
    with LEDGER.open('a') as f:
        if new:
            f.write('when\tdest\tfile\tbytes\tnote\n')
        f.write('\t'.join(str(c).replace('\t', ' ') for c in cols) + '\n')


def notify(msg):
    subprocess.run(['osascript', '-e', f'display notification {json.dumps(msg)} with title "Scanner"'],
                   capture_output=True)


def main():
    try:
        send_dests()
    except Exception as e:
        print('folder list not sent:', e, file=sys.stderr)

    waiting = json.loads(call('GET', '/list'))
    for o in waiting:  # the phone URI-encodes these so Thai and dashes survive the headers
        for k in ('name', 'dest', 'group', 'side', 'event'):
            o[k] = urllib.parse.unquote(o.get(k) or '')
    groups = {}
    for o in waiting:
        groups.setdefault(o.get('group') or o['id'], []).append(o)
    now = dt.datetime.now(dt.timezone.utc)
    stamp = dt.datetime.now().strftime('%Y-%m-%d %H%M')

    for g, files in groups.items():
        newest = max(dt.datetime.fromisoformat(o['uploaded'].replace('Z', '+00:00')) for o in files)
        if (now - newest).total_seconds() < QUIET:
            continue
        files.sort(key=lambda o: (o.get('side') == 'back', o['uploaded']))
        dest = files[0].get('dest', '')

        if dest == 'cards':
            for o in files:
                p = land(o, CARD_DROP, clean(o.get('name'), o['type']))
                log(stamp, 'cards', p, o['size'], o.get('side', ''))
            event = files[0].get('event')
            cmd = [sys.executable, str(CARDS)] + (['--event', event] if event else [])
            r = subprocess.run(cmd, capture_output=True, text=True)
            said = (r.stdout + r.stderr).strip().splitlines()
            print('\n'.join(said))
            for o in files:
                call('DELETE', '/f/' + o['id'])
            first = next((s for s in said if s.startswith('#')), 'a card')
            notify('Card in Contacts: ' + first.split('  ')[1] if '  ' in first else 'Card read into Contacts')
            continue

        label, where = folder(dest)
        for o in files:
            p = land(o, where, stamp + ' ' + clean(o.get('name'), o['type']))
            call('DELETE', '/f/' + o['id'])
            log(stamp, label, p, o['size'], '')
            print('→', p)
            notify(f'{p.name} → {label}')


if __name__ == '__main__':
    main()
