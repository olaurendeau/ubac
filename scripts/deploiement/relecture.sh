#!/usr/bin/env bash
# LA RELECTURE du job `deploy` (lot R3, extraite de ci.yml en Y7a a
# comportement constant) : l'image est la nouvelle, et tout le reste vaut ce
# qu'il valait avant — reglages, variables, declencheur, secrets. L'etat d'avant
# ayant passe les controles, l'egalite porte les valeurs epinglees. Les ecarts
# se nomment par leur cle, jamais par leur valeur.
#
# Parametre par l'environnement du job : UBAC_REFERENCE, l'image attendue ; et
# par celui du runner : RUNNER_TEMP, GITHUB_STEP_SUMMARY.
# Lit $RUNNER_TEMP/{avant,apres}-{definition,declencheurs,secrets}.json.
#
# test/ci/deploiement.test.ts l'execute tel que ci.yml l'appelle.
set -euo pipefail

motifs=$(jq -r -n \
  --slurpfile av "$RUNNER_TEMP/avant-definition.json" --slurpfile ap "$RUNNER_TEMP/apres-definition.json" \
  --slurpfile dav "$RUNNER_TEMP/avant-declencheurs.json" --slurpfile dap "$RUNNER_TEMP/apres-declencheurs.json" \
  --slurpfile sav "$RUNNER_TEMP/avant-secrets.json" --slurpfile sap "$RUNNER_TEMP/apres-secrets.json" \
  --arg image "$UBAC_REFERENCE" '
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
           $sap[0] | par(.env_var.name // .file.path // .secret_id); "secret")
  ] | .[]')
if [[ -n "$motifs" ]]; then
  printf "RELECTURE EN ECHEC, la production a change : %s\n" "$motifs" >&2
  exit 1
fi
jq -r '"relu : \(.image_uri), cpu \(.cpu_limit), memoire \(.memory_limit), delai \(.job_timeout), tentatives \(.retry_policy.max_retries), variables \(.environment_variables | keys | join(" "))"' \
  "$RUNNER_TEMP/apres-definition.json" | tee -a "$GITHUB_STEP_SUMMARY"
