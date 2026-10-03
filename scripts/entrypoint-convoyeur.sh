#!/bin/sh
# Point d'entree du conteneur du CONVOYEUR (lot Y6, Q7). Il tourne dans l'image
# `ubac-convoyeur`, jamais sur le poste. Il ne lance que `dist/convoyeur/main.js`
# (CV3) : l'image n'a pas `dist/jobs/`, et `scripts/verifier-image.sh` le constate.
set -eu

# Pose par `ARG GIT_SHA` a la construction (Dockerfile.prod, cible convoyeur).
: "${UBAC_GIT_SHA:?absent : image construite sans --build-arg GIT_SHA}"

# UN SEUL appel a `date` : son jour UTC identifie le convoyage.
AT=$(date -u +%FT%TZ)

echo "convoyeur: at=${AT} git_sha=${UBAC_GIT_SHA}"

# Les arguments du declencheur sont ajoutes APRES les notres. Sans argument, le
# passage est un DRY_RUN ; le reel est `--reel`, ajoute a la main au declencheur
# dans la console (DP5 = 2). Un argument inconnu refuse le demarrage
# (src/convoyeur/main.ts).
exec node dist/convoyeur/main.js \
  --at="${AT}" \
  --git-sha="${UBAC_GIT_SHA}" \
  "$@"
