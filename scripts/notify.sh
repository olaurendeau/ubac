#!/usr/bin/env bash
# Pousse un rapport court sur ntfy.
# Usage : notify.sh "<titre>" "<corps>" [priorite] [url_action]
set -euo pipefail

: "${NTFY_URL:?NTFY_URL non defini}"      # ex: https://ntfy.example.fr
: "${NTFY_TOPIC:?NTFY_TOPIC non defini}"

TITLE="${1:-Agent}"
BODY="${2:-}"
PRIORITY="${3:-default}"
ACTION_URL="${4:-}"

ARGS=(-s -o /dev/null -w '%{http_code}'
      -H "Title: ${TITLE}"
      -H "Priority: ${PRIORITY}"
      -H "Tags: robot")

if [[ -n "${NTFY_TOKEN:-}" ]]; then
  ARGS+=(-H "Authorization: Bearer ${NTFY_TOKEN}")
fi

if [[ -n "${ACTION_URL}" ]]; then
  ARGS+=(-H "Actions: view, Ouvrir la PR, ${ACTION_URL}")
fi

code=$(curl "${ARGS[@]}" -d "${BODY}" "${NTFY_URL}/${NTFY_TOPIC}")
[[ "${code}" == "200" ]] || { echo "ntfy a repondu ${code}" >&2; exit 1; }
