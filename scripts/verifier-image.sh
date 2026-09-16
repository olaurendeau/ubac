#!/usr/bin/env bash
# Verifie une image de production DEJA CONSTRUITE, avant de la pousser.
#
# Chaque controle porte sur une panne qui ne se verrait qu'en production, ou
# qu'on ne verrait pas du tout. Le script n'affirme rien : il interroge l'image
# et affiche ce qu'elle repond. Ce qu'il ne peut pas verifier est dit dans
# docs/deploiement.md plutot que suppose ici.
#
# Usage : ./scripts/verifier-image.sh <reference-image>
set -uo pipefail

REFERENCE=${1:-}
if [ -z "$REFERENCE" ]; then
  echo "usage : ./scripts/verifier-image.sh <depot>:<sha>" >&2
  exit 1
fi

# La seule architecture livrable (spec §10). Une constante : elle sert et de
# valeur attendue, et de plateforme d'execution ici — sans quoi Docker emule en
# emettant sur stderr un avertissement que ces controles liraient comme une
# sortie de commande.
PLATEFORME=linux/amd64

ECHECS=0

# Un controle : son intitule, ce qu'on attend, ce qu'on a lu. L'ecart est
# affiche, pas resume — un « ECHEC » sans la valeur lue oblige a tout refaire
# a la main.
controle() {
  local intitule=$1 attendu=$2 lu=$3
  if [ "$attendu" = "$lu" ]; then
    printf 'OK    %s\n' "$intitule"
  else
    printf 'ECHEC %s\n        attendu : %s\n        lu      : %s\n' "$intitule" "$attendu" "$lu"
    ECHECS=$((ECHECS + 1))
  fi
}

inspecter() { docker image inspect --format "$1" "$REFERENCE" 2>&1; }

# Dans l'image, sans reseau : aucun de ces controles n'a de raison d'en ouvrir un,
# et le lui interdire prouve au passage que le point d'entree n'en a pas besoin
# pour refuser une configuration absente.
dans_image() {
  docker run --rm --network none --platform "$PLATEFORME" --entrypoint sh "$REFERENCE" -c "$1" 2>&1
}

echo "image : $REFERENCE"
echo

# 1. L'architecture. La panne que la spec §10 nomme : une image ARM poussee
#    depuis un Mac demarre sur Scaleway en « exec format error », a 7 h du matin.
controle "architecture de l'image" "$PLATEFORME" "$(inspecter '{{.Os}}/{{.Architecture}}')"

# 2. Le SHA embarque, et son accord avec le tag. C'est lui que le job passera en
#    --git-sha, donc lui qui finira dans decisions.git_sha : s'il diverge du tag,
#    la tracabilite du §10 est perdue sans que rien ne le signale.
SHA_IMAGE=$(inspecter '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^UBAC_GIT_SHA=//p')
controle "SHA embarque == tag de l'image" "${REFERENCE##*:}" "$SHA_IMAGE"

# 3. Aucune devDependency. La liste est lue DANS l'image, pas sur le poste : un
#    paquet retire du package.json du depot mais reste dans l'image passerait
#    inapercu si on comparait a autre chose qu'a ce que l'image porte.
RESTANTES=$(docker run --rm --network none --platform "$PLATEFORME" \
  --entrypoint node "$REFERENCE" --input-type=commonjs -e '
  const { existsSync, readFileSync } = require("node:fs");
  const pkg = JSON.parse(readFileSync("/app/package.json", "utf8"));
  const restantes = Object.keys(pkg.devDependencies ?? {}).filter((nom) =>
    existsSync(`/app/node_modules/${nom}`),
  );
  process.stdout.write(restantes.join(","));
' 2>&1)
controle "aucune devDependency dans node_modules" "" "$RESTANTES"

# 4. drizzle-kit, nommement. C'est le paquet dont `push` execute ses DROP sans
#    confirmation hors terminal (docs/base-de-donnees.md §5). Une image qui ne
#    l'embarque pas ne peut pas le lancer, meme sur une ligne de commande
#    recopiee par erreur dans la definition du job.
controle "drizzle-kit absent de l'image" "" \
  "$(dans_image 'find /app /usr/local/lib/node_modules -name "drizzle-kit*" 2>/dev/null | head -5')"

# 5. tsx et le compilateur : le job demarre sur du JavaScript deja compile.
controle "ni tsx ni tsc dans node_modules/.bin" "" \
  "$(dans_image 'ls /app/node_modules/.bin 2>/dev/null | grep -E "^(tsx|tsc|vitest|eslint)$"')"

# 6. Aucune source TypeScript livree : ce qui tourne est ce qui a ete compile.
controle "aucun .ts dans dist/" "" "$(dans_image 'find /app/dist -name "*.ts" | head -5')"

# 7. Le job ne lit ni n'ecrit de fichier : rien ne justifie root.
controle "utilisateur non privilegie" "node" "$(inspecter '{{.Config.User}}')"

# 8. Le point d'entree demarre. Sans variable et sans reseau, il doit aller
#    jusqu'a loadConfig() et refuser en nommant la premiere variable manquante.
#    C'est la preuve que tout le graphe ESM se resout dans l'image — ccxt, pg,
#    drizzle-orm, zod — et que le script d'entree fabrique bien ses dates.
SORTIE=$(docker run --rm --network none --platform "$PLATEFORME" "$REFERENCE" 2>&1)
CODE=$?
controle "code de sortie sans configuration" "1" "$CODE"
case "$SORTIE" in
  *DATABASE_URL*) printf 'OK    refus de configuration en nommant la variable\n' ;;
  *)
    printf 'ECHEC le point d’entree n’a pas atteint loadConfig()\n        lu : %s\n' "$SORTIE"
    ECHECS=$((ECHECS + 1))
    ;;
esac
case "$SORTIE" in
  *"run_date="*"git_sha=$SHA_IMAGE"*) printf 'OK    le point d’entree passe run_date, at et git_sha\n' ;;
  *)
    printf 'ECHEC le point d’entree n’a pas journalise ses arguments\n        lu : %s\n' "$SORTIE"
    ECHECS=$((ECHECS + 1))
    ;;
esac

echo
if [ "$ECHECS" -eq 0 ]; then
  echo "tous les controles passent — l'image peut etre poussee."
else
  echo "$ECHECS controle(s) en echec — NE PAS POUSSER."
fi
exit "$ECHECS"
