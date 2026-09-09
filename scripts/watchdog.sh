#!/usr/bin/env bash
# Detecte les workers idle : un agent dont le worktree n'a pas bouge depuis N minutes.
# Contre-mesure au bug ou worker-start retourne ok:true alors que le prompt
# n'a jamais ete soumis (le coordinateur croit que ca travaille).
#
# A lancer en cron toutes les 5 minutes sur l'hote.
# Usage : IDLE_MIN=15 WORKTREE_ROOT=~/worktrees watchdog.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IDLE_MIN="${IDLE_MIN:-15}"
WORKTREE_ROOT="${WORKTREE_ROOT:?WORKTREE_ROOT non defini}"

now=$(date +%s)
stale=()

for wt in "${WORKTREE_ROOT}"/*/; do
  [[ -d "${wt}/.git" || -f "${wt}/.git" ]] || continue

  # Marqueur de demarrage pose par le coordinateur au lancement du worker.
  marker="${wt}/.orca-started"
  [[ -f "${marker}" ]] || continue

  started=$(stat -c %Y "${marker}" 2>/dev/null || stat -f %m "${marker}")
  age_min=$(( (now - started) / 60 ))
  [[ ${age_min} -ge ${IDLE_MIN} ]] || continue

  # Le worker a-t-il produit quoi que ce soit depuis son demarrage ?
  changes=$(cd "${wt}" && git status --porcelain | wc -l | tr -d ' ')
  commits=$(cd "${wt}" && git log --since="${age_min} minutes ago" --oneline | wc -l | tr -d ' ')

  if [[ "${changes}" == "0" && "${commits}" == "0" ]]; then
    stale+=("$(basename "${wt}") idle depuis ${age_min} min")
  fi
done

if [[ ${#stale[@]} -gt 0 ]]; then
  body=$(printf '%s\n' "${stale[@]}")
  "${DIR}/notify.sh" "Workers idle" "${body}" "high"
fi
