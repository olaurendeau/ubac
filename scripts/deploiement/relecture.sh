#!/usr/bin/env bash
# LA RELECTURE des jobs `deploy` et `deploy-convoyeur` (lot R3, extraite de
# ci.yml en Y7a a comportement constant, appelee deux fois en Y7b) : l'image est
# la nouvelle, et tout le reste vaut ce qu'il valait avant — reglages,
# variables, declencheur, secrets. L'etat d'avant ayant passe les controles,
# l'egalite porte les valeurs epinglees. Les ecarts se nomment par leur cle,
# jamais par leur valeur.
#
# Parametre par l'environnement du job : REFERENCE, l'image attendue ; par
# celui de l'etape : ARGUMENT_REEL et DECLENCHEUR, facultatifs, pour constater
# que le mode du convoyeur n'a pas change pendant le deploiement (DP5 = 2) ;
# et par celui du runner : RUNNER_TEMP, GITHUB_STEP_SUMMARY.
# Lit $RUNNER_TEMP/{avant,apres}-{definition,declencheurs,secrets}.json.
#
# test/ci/deploiement.test.ts l'execute tel que ci.yml l'appelle.
set -euo pipefail

# Le mode, avant et apres : la console a pu le changer pendant le deploiement.
mode_avant="" mode_apres=""
if [[ -n "${ARGUMENT_REEL:-}" ]]; then
  lire_mode() { jq -r --arg nom "$DECLENCHEUR" --arg reel "$ARGUMENT_REEL" -f "$(dirname "$0")/mode.jq" "$1"; }
  mode_avant=$(lire_mode "$RUNNER_TEMP/avant-declencheurs.json")
  mode_apres=$(lire_mode "$RUNNER_TEMP/apres-declencheurs.json")
fi

motifs=$(jq -r -n \
  --slurpfile av "$RUNNER_TEMP/avant-definition.json" --slurpfile ap "$RUNNER_TEMP/apres-definition.json" \
  --slurpfile dav "$RUNNER_TEMP/avant-declencheurs.json" --slurpfile dap "$RUNNER_TEMP/apres-declencheurs.json" \
  --slurpfile sav "$RUNNER_TEMP/avant-secrets.json" --slurpfile sap "$RUNNER_TEMP/apres-secrets.json" \
  --arg image "$REFERENCE" --arg mode_avant "$mode_avant" --arg mode_apres "$mode_apres" '
  def liste: if type == "array" then . else (.triggers // .secrets) end;
  def par(cle): liste | map({(cle): .}) | add // {};
  def ecarts($a; $b; $quoi):
    ($a + $b | keys[]) as $k | select($a[$k] != $b[$k])
    | "\($quoi) \($k) : ajoute, retire ou change pendant le deploiement";
  [ (if $ap[0].image_uri != $image then "image-uri relue « \($ap[0].image_uri) », attendu « \($image) »" else empty end),
    ecarts($av[0] | del(.image_uri, .updated_at, .environment_variables);
           $ap[0] | del(.image_uri, .updated_at, .environment_variables); "reglage"),
    ecarts($av[0].environment_variables // {}; $ap[0].environment_variables // {}; "variable"),
    ecarts($dav[0] | par(.name); $dap[0] | par(.name); "declencheur"),
    ecarts($sav[0] | par(.env_var.name // .file.path // .secret_id);
           $sap[0] | par(.env_var.name // .file.path // .secret_id); "secret"),
    (if $mode_avant != $mode_apres
     then "mode du convoyeur \($mode_avant) avant, \($mode_apres) apres : change pendant le deploiement" else empty end)
  ] | .[]')
if [[ -n "$motifs" ]]; then
  printf "RELECTURE EN ECHEC, la production a change : %s\n" "$motifs" >&2
  exit 1
fi
jq -r '"relu : \(.image_uri), cpu \(.cpu_limit), memoire \(.memory_limit), delai \(.job_timeout), tentatives \(.retry_policy.max_retries), variables \(.environment_variables // {} | keys | join(" "))"' \
  "$RUNNER_TEMP/apres-definition.json" | tee -a "$GITHUB_STEP_SUMMARY"
[[ -z "$mode_apres" ]] || echo "mode du convoyeur relu, inchange : $mode_apres" | tee -a "$GITHUB_STEP_SUMMARY"
