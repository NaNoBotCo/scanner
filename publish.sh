#!/bin/bash
# docs/ is what GitHub Pages serves, so publishing is a style gate and a push.
set -euo pipefail
cd "$(dirname "$0")"

STYLE="$HOME/.claude/bin/stylecheck.py"
if [ -f "$STYLE" ]; then
  python3 "$STYLE" docs README.txt || { echo "REFUSED: style. See ~/.claude/STYLE.md"; exit 4; }
fi

python3 tools/icons.py

if grep -rl "/Users/" docs >/dev/null 2>&1; then
  echo "REFUSED: host paths found in docs/"; exit 2
fi

git add -A
git commit -m "${1:-scanner update}" || echo "nothing to commit"
git push origin main
echo "pushed — https://nanobotco.github.io/scanner/"
