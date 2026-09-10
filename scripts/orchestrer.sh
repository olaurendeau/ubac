#!/usr/bin/env bash
# Coordinateur du kit workflow.
#
# Deroule les etapes d'un plan : un worktree et une session claude par etape,
# relecture en session neuve, merge automatique sur verdict PASSE.
# C'est la piece que docs/workflow-dev.md §4 phase C confie a un "coordinateur".
#
# Usage : orchestrer.sh [--dry-run] [--only E3] [--slots N] <slug>
# Env   : WORKTREE_ROOT (defaut ~/worktrees), SLOTS (defaut 3),
#         MAX_BUDGET_USD (optionnel), MODEL (optionnel),
#         NTFY_URL / NTFY_TOPIC (sinon les rapports vont sur stdout)
set -euo pipefail

DRY_RUN=0
ONLY=""
SLOTS="${SLOTS:-3}"
SLUG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --only)    ONLY="${2#E}"; shift 2 ;;
    --slots)   SLOTS="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*)        echo "option inconnue : $1" >&2; exit 2 ;;
    *)         SLUG="$1"; shift ;;
  esac
done

[[ -n "${SLUG}" ]] || { echo "usage : orchestrer.sh [--dry-run] [--only E3] <slug>" >&2; exit 2; }

REPO="$(git rev-parse --show-toplevel)"
PLAN="${REPO}/docs/plans/${SLUG}.md"
RUN_DIR="${REPO}/.claude/runs/${SLUG}"
WORKTREE_ROOT="${WORKTREE_ROOT:-${HOME}/worktrees}"

[[ -f "${PLAN}" ]] || { echo "plan introuvable : ${PLAN}" >&2; exit 1; }
mkdir -p "${RUN_DIR}" "${WORKTREE_ROOT}"

notify() {  # notify <titre> <corps> [priorite] [url]
  if [[ -n "${NTFY_URL:-}" && -n "${NTFY_TOPIC:-}" ]]; then
    "${REPO}/scripts/notify.sh" "$@" || echo "[notify a echoue] $1" >&2
  else
    echo "[ntfy non configure] $1 : $2"
  fi
}

# --- lecture du plan -------------------------------------------------------

declare -A TITLE=() DEPS=() FILES=() STATE=() PID=()
ORDER=()

while IFS=$'\t' read -r n title deps files; do
  [[ -n "${n}" ]] || continue
  TITLE[$n]="${title}"
  # "aucune" ou "E4, E6" -> "" ou "4 6"
  if [[ "${deps}" =~ ^[Aa]ucune ]]; then
    DEPS[$n]=""
  else
    DEPS[$n]="$(tr ',' '\n' <<<"${deps}" | grep -oE 'E[0-9]+' | tr -d 'E' | tr '\n' ' ')"
  fi
  # "`a.ts`, `b.ts`" -> "a.ts b.ts"
  FILES[$n]="$(tr -d '`' <<<"${files}" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$' | tr '\n' ' ')"
  STATE[$n]="pending"
  ORDER+=("$n")
done < <(awk '
  function flush() { if (n != "") printf "%s\t%s\t%s\t%s\n", n, title, deps, files }
  /^### E[0-9]+ / { flush(); n=$2; sub(/^E/,"",n)
                    title=$0; sub(/^### E[0-9]+ +- +/,"",title)
                    deps=""; files=""; next }
  /^- Depend de *:/        { deps=$0;  sub(/^- Depend de *: */,"",deps);        next }
  /^- Fichiers touches *:/ { files=$0; sub(/^- Fichiers touches *: */,"",files); next }
  END { flush() }
' "${PLAN}")

[[ ${#ORDER[@]} -gt 0 ]] || { echo "aucune etape trouvee dans ${PLAN}" >&2; exit 1; }

# --- reprise : etat sur disque, puis PR deja mergees -----------------------

for n in "${ORDER[@]}"; do
  [[ -f "${RUN_DIR}/E${n}.state" ]] && STATE[$n]="$(cat "${RUN_DIR}/E${n}.state")"
done

if merged_json="$(gh pr list --state merged --limit 200 --json number,headRefName 2>/dev/null)"; then
  while IFS=$'\t' read -r num ref; do
    n="${ref#etape/${SLUG}-}"
    [[ "${n}" != "${ref}" && -n "${TITLE[$n]:-}" ]] || continue
    STATE[$n]="merged"
    echo "merged" > "${RUN_DIR}/E${n}.state"
    echo "${num}" > "${RUN_DIR}/E${n}.pr"
  done < <(jq -r '.[] | [.number, .headRefName] | @tsv' <<<"${merged_json}")
fi

# --- helpers d'ordonnancement ---------------------------------------------

deps_satisfaites() {
  local n="$1" d
  for d in ${DEPS[$n]}; do
    [[ "${STATE[$d]:-pending}" == "merged" ]] || return 1
  done
  return 0
}

# Deux etapes qui ecrivent le meme fichier ne partent jamais ensemble :
# E7/E8 touchent toutes deux src/core/risk.ts, E11/E12 rebalance.ts.
# Sans ce mutex, la seconde casse au merge automatique.
collision_avec_running() {
  local n="$1" m f g
  for m in "${!PID[@]}"; do
    for f in ${FILES[$n]}; do
      for g in ${FILES[$m]}; do
        [[ "${f}" == "${g}" ]] && return 0
      done
    done
  done
  return 1
}

eligibles() {
  local n
  for n in "${ORDER[@]}"; do
    [[ "${STATE[$n]}" == "pending" || "${STATE[$n]}" == "relecture_ko" ]] || continue
    [[ -z "${ONLY}" || "${ONLY}" == "${n}" ]] || continue
    deps_satisfaites "${n}" || continue
    echo "${n}"
  done
}

# --- dry run ---------------------------------------------------------------

if [[ ${DRY_RUN} -eq 1 ]]; then
  echo "Plan ${SLUG} : ${#ORDER[@]} etapes, ${SLOTS} creneaux, worktrees dans ${WORKTREE_ROOT}"
  echo
  declare -A SIM
  for n in "${ORDER[@]}"; do SIM[$n]="${STATE[$n]}"; done
  vague=0
  while :; do
    prets=()
    for n in "${ORDER[@]}"; do
      [[ "${SIM[$n]}" == "pending" || "${SIM[$n]}" == "relecture_ko" ]] || continue
      ok=1; for d in ${DEPS[$n]}; do [[ "${SIM[$d]}" == "merged" ]] || ok=0; done
      [[ ${ok} -eq 1 ]] && prets+=("$n")
    done
    [[ ${#prets[@]} -gt 0 ]] || break
    vague=$((vague+1))
    lancees=(); pris=(); par_mutex=(); par_creneau=()
    for n in "${prets[@]}"; do
      if [[ ${#lancees[@]} -ge ${SLOTS} ]]; then par_creneau+=("E$n"); continue; fi
      conflit=""
      for f in ${FILES[$n]}; do
        for g in "${pris[@]:-}"; do [[ "${f}" == "${g}" ]] && conflit="${f}"; done
      done
      if [[ -n "${conflit}" ]]; then par_mutex+=("E${n} (${conflit})"); continue; fi
      lancees+=("$n"); for f in ${FILES[$n]}; do pris+=("$f"); done
    done
    printf 'vague %-2s :' "${vague}"
    for n in "${lancees[@]}"; do printf ' E%s' "$n"; done
    echo
    [[ ${#par_mutex[@]}   -gt 0 ]] && printf '           mutex fichier   : %s\n' "$(IFS=', '; echo "${par_mutex[*]}")"
    [[ ${#par_creneau[@]} -gt 0 ]] && printf '           creneaux pleins : %s\n' "${par_creneau[*]}"
    for n in "${lancees[@]}"; do SIM[$n]="merged"; done
  done
  echo
  deja=(); for n in "${ORDER[@]}"; do [[ "${STATE[$n]}" == "merged" ]] && deja+=("E$n"); done
  [[ ${#deja[@]} -gt 0 ]] && echo "deja mergees, sautees : ${deja[*]}"
  exit 0
fi

# --- cycle d'une etape (tourne en arriere-plan) ---------------------------

CLAUDE_ARGS=(--permission-mode bypassPermissions --output-format json)
[[ -n "${MODEL:-}" ]] && CLAUDE_ARGS+=(--model "${MODEL}")
[[ -n "${MAX_BUDGET_USD:-}" ]] && CLAUDE_ARGS+=(--max-budget-usd "${MAX_BUDGET_USD}")

SCHEMA='{"type":"object","properties":{"verdict":{"type":"string","enum":["PASSE","BLOQUE"]},"bloquants":{"type":"array","items":{"type":"string"}}},"required":["verdict","bloquants"]}'

run_step() {
  local n="$1"
  local branche="etape/${SLUG}-${n}"
  local wt="${WORKTREE_ROOT}/${SLUG}-${n}"
  local wt_relire="${WORKTREE_ROOT}/relire-${SLUG}-${n}"
  local log="${RUN_DIR}/E${n}.log"
  local etat="${RUN_DIR}/E${n}.state"

  set +e
  {
    echo "=== E${n} : ${TITLE[$n]}"
    date -Is

    git -C "${REPO}" fetch origin main --quiet
    if [[ ! -d "${wt}" ]]; then
      git -C "${REPO}" worktree add "${wt}" -b "${branche}" origin/main >/dev/null 2>&1 \
        || git -C "${REPO}" worktree add "${wt}" "${branche}" >/dev/null
    fi
    touch "${wt}/.orca-started"   # alimente scripts/watchdog.sh

    # node_modules par lien dur : 90 Mo, et le worktree en a besoin pour
    # verifier le critere de validation de l'etape.
    if [[ ! -d "${wt}/node_modules" ]]; then
      cp -al "${REPO}/node_modules" "${wt}/node_modules" 2>/dev/null \
        || ( cd "${wt}" && npm ci --silent )
    fi

    if [[ "$(cat "${etat}" 2>/dev/null)" == "relecture_ko" && -s "${RUN_DIR}/E${n}.pr" ]]; then
      echo "--- reprise : construction deja faite, on relance la relecture seule"
    else
      echo "building" > "${etat}"
      ( cd "${wt}" && claude -p "/construire ${SLUG} E${n}" "${CLAUDE_ARGS[@]}" )
      echo "--- fin construire, code $?"
    fi

    local pr
    pr="$(cd "${wt}" && gh pr view --json number -q .number 2>/dev/null)"
    if [[ -z "${pr}" ]]; then
      echo "aucune PR ouverte pour ${branche}"
      echo "bloque" > "${etat}"
      exit 0
    fi
    echo "${pr}" > "${RUN_DIR}/E${n}.pr"
    echo "PR #${pr}"

    # Relecture : processus distinct, worktree propre, jamais --continue ni
    # --resume. Le contexte vide est garanti par construction, pas par consigne.
    echo "review" > "${etat}"
    rm -rf "${wt_relire}"
    git -C "${REPO}" worktree add --detach "${wt_relire}" origin/main >/dev/null
    local out verdict
    out="$(cd "${wt_relire}" && claude -p "/relire ${pr}" "${CLAUDE_ARGS[@]}" --json-schema "${SCHEMA}")"
    echo "${out}"
    verdict="$(jq -r '.result' <<<"${out}" 2>/dev/null | jq -r '.verdict' 2>/dev/null)"
    [[ "${verdict}" == "PASSE" || "${verdict}" == "BLOQUE" ]] \
      || verdict="$(grep -oE 'PASSE|BLOQUE' <<<"${out}" | head -1)"
    echo "--- verdict : ${verdict:-illisible}"

    local url
    url="$(gh pr view "${pr}" --json url -q .url 2>/dev/null || true)"

    if [[ "${verdict}" == "PASSE" ]]; then
      if gh pr merge "${pr}" --squash --delete-branch; then
        echo "merged" > "${etat}"
      else
        echo "bloque" > "${etat}"
        notify "E${n} merge impossible" "Verdict PASSE mais le merge de la PR ${pr} a echoue. Conflit probable." "high" "${url}"
      fi
    elif [[ "${verdict}" == "BLOQUE" ]]; then
      echo "bloque" > "${etat}"
      notify "E${n} BLOQUE" "$(jq -r '.result' <<<"${out}" 2>/dev/null | jq -r '.bloquants[]?' 2>/dev/null | head -5)" "high" "${url}"
    else
      # Pas de verdict : panne reseau, budget epuise, session tuee. Ce n'est
      # pas un refus du relecteur et ca ne doit pas condamner l'etape. La
      # relecture seule sera rejouee au prochain passage.
      echo "relecture_ko" > "${etat}"
      notify "E${n} relecture impossible" "Aucun verdict lisible sur la PR ${pr}. Etape reprenable en relançant l'orchestrateur." "high" "${url}"
    fi

    git -C "${REPO}" worktree remove --force "${wt_relire}" 2>/dev/null
    [[ "$(cat "${etat}")" == "merged" ]] && git -C "${REPO}" worktree remove --force "${wt}" 2>/dev/null
    date -Is
  } >>"${log}" 2>&1
  set -e
}

# --- boucle d'ordonnancement ----------------------------------------------

echo "Orchestrateur ${SLUG} : ${#ORDER[@]} etapes, ${SLOTS} creneaux."
notify "Orchestrateur ${SLUG}" "Demarrage. $(for n in "${ORDER[@]}"; do [[ "${STATE[$n]}" != "merged" ]] && echo -n "."; done | wc -c) etapes a faire."

while :; do
  # moisson des workers termines
  for n in "${!PID[@]}"; do
    if ! kill -0 "${PID[$n]}" 2>/dev/null; then
      wait "${PID[$n]}" 2>/dev/null || true
      STATE[$n]="$(cat "${RUN_DIR}/E${n}.state" 2>/dev/null || echo bloque)"
      echo "  E${n} -> ${STATE[$n]}"
      unset 'PID[$n]'
    fi
  done

  # lancement
  while [[ ${#PID[@]} -lt ${SLOTS} ]]; do
    suivant=""
    for n in $(eligibles); do
      collision_avec_running "${n}" && continue
      suivant="${n}"; break
    done
    [[ -n "${suivant}" ]] || break
    STATE[$suivant]="building"
    echo "  E${suivant} demarre : ${TITLE[$suivant]}"
    run_step "${suivant}" &
    PID[$suivant]=$!
  done

  [[ ${#PID[@]} -eq 0 ]] && [[ -z "$(eligibles)" ]] && break
  sleep 10
done

# --- rapport ---------------------------------------------------------------

merged=(); bloques=(); a_rejouer=(); restants=()
for n in "${ORDER[@]}"; do
  case "${STATE[$n]}" in
    merged)        merged+=("E$n") ;;
    bloque)        bloques+=("E$n") ;;
    relecture_ko)  a_rejouer+=("E$n") ;;
    *)             restants+=("E$n") ;;
  esac
done

{
  echo "Fait : ${#merged[@]} etapes mergees sur ${#ORDER[@]} pour ${SLUG}."
  if [[ ${#bloques[@]} -gt 0 ]]; then
    echo "Bloque : ${bloques[*]} sur verdict du relecteur${a_rejouer:+, ${a_rejouer[*]} sans verdict lisible}."
  elif [[ ${#a_rejouer[@]} -gt 0 ]]; then
    echo "Bloque : ${a_rejouer[*]}, relecture sans verdict lisible, reprenable en relançant."
  else
    echo "Bloque : rien"
  fi
  if [[ ${#bloques[@]} -gt 0 ]]; then
    echo "Decision attendue : trancher ${bloques[0]}, ${#restants[@]} etapes attendent derriere."
  elif [[ ${#a_rejouer[@]} -gt 0 ]]; then
    echo "Decision attendue : aucune, relancer l'orchestrateur suffit."
  else
    echo "Decision attendue : aucune"
  fi
} > "${REPO}/.claude/last-report.md"

cat "${REPO}/.claude/last-report.md"
notify "Orchestrateur ${SLUG}" "$(cat "${REPO}/.claude/last-report.md")"
