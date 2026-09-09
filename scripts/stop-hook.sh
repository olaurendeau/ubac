#!/usr/bin/env bash
# Hook Stop de Claude Code : envoie un rapport 3 lignes a la fin d'une session.
# Le hook recoit le payload JSON de Claude Code sur stdin.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PAYLOAD="$(cat)"

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
LAST="$(git log -1 --pretty=%s 2>/dev/null || echo 'aucun commit')"
PR_URL="$(gh pr view --json url -q .url 2>/dev/null || true)"

# Le resume est ecrit par l'agent dans .claude/last-report.md (voir CLAUDE.md).
if [[ -f .claude/last-report.md ]]; then
  BODY="$(head -c 900 .claude/last-report.md)"
else
  BODY="Fait : ${LAST}
Bloque : non renseigne
Decision attendue : aucune"
fi

"${DIR}/notify.sh" "[${BRANCH}]" "${BODY}" "default" "${PR_URL}"
