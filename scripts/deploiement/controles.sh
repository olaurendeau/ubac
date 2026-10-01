#!/usr/bin/env bash
# Les controles avant du job `deploy` (lot R3, extraits de ci.yml en Y7a a
# comportement constant) : le tag precedent est ecrit, la production est dans
# l'etat attendu, le run est loin. Un refus ici laisse la definition intacte :
# le script ne fait que lire les fichiers de la lecture avant.
#
# Parametre par son environnement, que l'etape `controles` de ci.yml epingle :
#   CPU_MVCPU, MEMOIRE_MIO, DELAI_S, TENTATIVES  les reglages attendus
#   DECLENCHEUR  le nom du seul declencheur admis
#   FENETRE_MIN  le refus autour du run, en minutes
#   VARIABLES    les variables exigees, ordinaires ou secretes
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
motifs=$(jq -r -n \
  --slurpfile definition "$avant-definition.json" \
  --slurpfile declencheurs "$avant-declencheurs.json" \
  --slurpfile secrets "$avant-secrets.json" \
  --argjson cpu "$CPU_MVCPU" --argjson memoire "$MEMOIRE_MIO" \
  --argjson delai "$DELAI_S" --argjson tentatives "$TENTATIVES" \
  --arg declencheur "$DECLENCHEUR" --arg variables "$VARIABLES" '
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
      (if ($t | length) != 1 or $t[0].name != $declencheur
       then "declencheurs \([$t[].name]), attendu le seul « \($declencheur) »" else empty end)
    ] | .[]')
if [[ -n "$motifs" ]]; then
  printf "REFUS, rien n'a ete modifie : %s\n" "$motifs" >&2
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
