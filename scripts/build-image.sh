#!/usr/bin/env bash
# Construit l'image de PRODUCTION, taguee par SHA de commit, pour linux/amd64.
#
# Ce script NE POUSSE RIEN et NE DEPLOIE RIEN. Il construit, il affiche la
# commande qu'il lance, et il s'arrete. Pousser et deployer sont deux gestes de
# l'operateur, decrits dans docs/deploiement.md.
#
# Usage : ./scripts/build-image.sh <depot-image>
#         UBAC_IMAGE=rg.fr-par.scw.cloud/<namespace>/ubac ./scripts/build-image.sh
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=${1:-${UBAC_IMAGE:-}}
if [ -z "$IMAGE" ]; then
  echo "usage : ./scripts/build-image.sh <depot-image>" >&2
  echo "        ex. rg.fr-par.scw.cloud/<namespace>/ubac, ou la variable UBAC_IMAGE" >&2
  exit 1
fi

# Un arbre de travail sale rend le tag MENSONGER : l'image contiendrait du code
# que le SHA ne decrit pas, et `decisions.git_sha` designerait un commit qui
# n'est pas celui qui a decide. C'est toute la tracabilite du §10 qui tombe,
# donc il n'y a pas de drapeau pour passer outre : on commite, ou on ne
# construit pas.
if [ -n "$(git status --porcelain)" ]; then
  echo "arbre de travail sale : l'image serait taguee par un SHA qui ne la decrit pas." >&2
  git status --short >&2
  exit 1
fi

SHA=$(git rev-parse --verify HEAD)
REFERENCE="${IMAGE}:${SHA}"

# `--platform linux/amd64` explicitement, meme si Dockerfile.prod le verifie :
# le garde-fou est un filet, pas la consigne. `--load` depose l'image dans le
# demon local pour que ./scripts/verifier-image.sh puisse la faire tourner.
#
# AUCUN tag `latest`, et c'est le point : le SHA est persiste dans `decisions`,
# donc on doit pouvoir dire quelle image tournait le jour d'une decision
# douteuse. Un `latest` qui bouge efface exactement cette reponse.
echo "+ docker buildx build --platform linux/amd64 --build-arg GIT_SHA=${SHA} \\"
echo "    -f Dockerfile.prod -t ${REFERENCE} --load ."
docker buildx build \
  --platform linux/amd64 \
  --build-arg "GIT_SHA=${SHA}" \
  -f Dockerfile.prod \
  -t "${REFERENCE}" \
  --load \
  .

echo
echo "image construite : ${REFERENCE}"
echo "suite : ./scripts/verifier-image.sh ${REFERENCE}"
