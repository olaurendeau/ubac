#!/usr/bin/env bash
# Les controles avant des jobs `deploy` et `deploy-convoyeur` (lot R3, extraits
# de ci.yml en Y7a a comportement constant, appeles deux fois en Y7b) : le tag
# precedent est ecrit, la production est dans l'etat attendu, le run est loin.
# Un refus ici laisse la definition intacte : le script ne fait que lire les
# fichiers de la lecture avant.
#
# Parametre par son environnement, que l'etape `controles` de ci.yml epingle :
#   CPU_MVCPU, MEMOIRE_MIO, DELAI_S, TENTATIVES  les reglages attendus
#   DECLENCHEUR  le nom du seul declencheur admis
#   FENETRE_MIN  le refus autour du run, en minutes
#   VARIABLES    les variables exigees, ordinaires ou secretes
#   INTERDITES   les variables refusees, ordinaires ou secretes ; `PREFIXE_*`
#                vaut pour tout nom qui commence par PREFIXE_ (CV3)
#   ARGUMENT_REEL  facultatif : l'argument du declencheur qui met en reel. Le
#                mode est lu et dit, il ne fait jamais refuser (DP5 = 2)
# et par celui du runner : DEFINITION, RUNNER_TEMP, GITHUB_STEP_SUMMARY.
# Lit $RUNNER_TEMP/avant-{definition,declencheurs,secrets}.json.
#
# test/ci/deploiement.test.ts l'execute tel que ci.yml l'appelle.
set -euo pipefail

avant="$RUNNER_TEMP/avant"
# Les variables ordinaires sont en clair : masquees des maintenant, une
# ligne qui les recopierait un jour ne montrerait que ***.
jq -r '.environment_variables // {} | .[]' "$avant-definition.json" \
  | while IFS= read -r valeur; do [[ -z "$valeur" ]] || echo "::add-mask::$valeur"; done
# Le tag precedent, avant tout controle : ces deux lignes SONT la
# procedure de retour en arriere (docs/deploiement.md §8).
precedente=$(jq -r '.image_uri' "$avant-definition.json")
retour="scw jobs definition update $DEFINITION image-uri=$precedente region=fr-par"
echo "image deployee jusqu'ici : $precedente"
echo "retour en arriere : $retour"
printf '### Retour en arriere\n\n    %s\n\n' "$retour" >> "$GITHUB_STEP_SUMMARY"
# Le mode, avant tout refus : un deploiement refuse le dit aussi. Lu dans les
# arguments du declencheur, ou la console le pose (OP6) ; jamais ecrit ici.
mode=""
if [[ -n "${ARGUMENT_REEL:-}" ]]; then
  mode=$(jq -r --arg nom "$DECLENCHEUR" --arg reel "$ARGUMENT_REEL" -f "$(dirname "$0")/mode.jq" "$avant-declencheurs.json")
  if [[ "$mode" != "non lu" ]]; then
    echo "mode du convoyeur : $mode"
    printf '### Mode du convoyeur\n\n%s\n\n' "$mode" >> "$GITHUB_STEP_SUMMARY"
  fi
fi
motifs=$(jq -r -n \
  --slurpfile definition "$avant-definition.json" \
  --slurpfile declencheurs "$avant-declencheurs.json" \
  --slurpfile secrets "$avant-secrets.json" \
  --argjson cpu "$CPU_MVCPU" --argjson memoire "$MEMOIRE_MIO" \
  --argjson delai "$DELAI_S" --argjson tentatives "$TENTATIVES" \
  --arg declencheur "$DECLENCHEUR" --arg variables "$VARIABLES" --arg interdites "$INTERDITES" '
  $definition[0] as $d
  | [$declencheurs[0] | if type == "array" then .[] else .triggers[] end] as $t
  | [$secrets[0] | if type == "array" then .[] else .secrets[] end | .env_var.name // empty] as $s
  | [ (if $d.cpu_limit != $cpu then "cpu-limit \($d.cpu_limit), attendu \($cpu)" else empty end),
      (if $d.memory_limit != $memoire then "memory-limit \($d.memory_limit), attendu \($memoire)" else empty end),
      (if ($d.job_timeout | tostring | sub("s$"; "") | tonumber? // null) != $delai
       then "job-timeout \($d.job_timeout), attendu \($delai)s" else empty end),
      (if $d.retry_policy.max_retries != $tentatives
       then "max-retries \($d.retry_policy.max_retries), attendu \($tentatives)" else empty end),
      (if $d.cron_schedule != null
       then "un cron sur la definition : seul le declencheur ordonnance le job" else empty end),
      ((($variables | split(" ") | map(select(. != ""))) - ([$d.environment_variables // {} | keys[]] + $s))[]
       | "variable \(.) absente : le job refuserait de demarrer"),
      (([$d.environment_variables // {} | keys[]] + $s | unique[]) as $n
       | select(any($interdites | split(" ")[] | select(. != "");
                    . as $p | if $p | endswith("*") then $n | startswith($p[:-1]) else $n == $p end))
       | "variable \($n) interdite sur cette definition, elle est a un autre job (CV3)"),
      (if ($t | length) != 1 or $t[0].name != $declencheur
       then "declencheurs \([$t[].name]), attendu le seul « \($declencheur) »" else empty end)
    ] | .[]')
if [[ -n "$motifs" ]]; then
  printf "REFUS, rien n'a ete modifie : %s\n" "$motifs" >&2
  exit 1
fi
# Une forme inattendue ne passe pas pour un DRY_RUN : le mode serait mal dit.
if [[ "$mode" == "non lu" ]]; then
  echo "REFUS, rien n'a ete modifie : arguments du declencheur « $DECLENCHEUR », forme non lue (attendu un tableau ou null) ; le mode ne serait pas dit" >&2
  exit 1
fi
# La fenetre se lit dans le declencheur lui-meme, dans SON fuseau :
# aucune heure n'est figee ici, et le changement d'heure est celui de
# la production.
ligne=$(jq -r '(if type == "array" then .[] else .triggers[] end)
  | [.cron_config.schedule, .cron_config.timezone] | @tsv' "$avant-declencheurs.json")
IFS=$'\t' read -r horaire fuseau <<< "$ligne"
if [[ ! "$horaire" =~ ^([0-9]{1,2})\ ([0-9]{1,2})\ \*\ \*\ \*$ || ! -f "/usr/share/zoneinfo/$fuseau" ]]; then
  echo "REFUS, rien n'a ete modifie : declencheur « $horaire » en « $fuseau », forme non lue (attendu « M H * * * » et un fuseau connu)" >&2
  exit 1
fi
run=$(( 10#${BASH_REMATCH[2]} * 60 + 10#${BASH_REMATCH[1]} ))
read -r h m <<< "$(TZ="$fuseau" date +'%H %M')"
ecart=$(( (10#$h * 60 + 10#$m - run + 1440) % 1440 ))
(( ecart <= 720 )) || ecart=$(( 1440 - ecart ))
if (( ecart <= FENETRE_MIN )); then
  echo "REFUS, rien n'a ete modifie : il est $h:$m en $fuseau, a $ecart min du run « $horaire » ; relancer le job hors des $FENETRE_MIN min qui l'entourent" >&2
  exit 1
fi
echo "controles avant : etat attendu, run a $ecart min"
