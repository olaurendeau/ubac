#!/bin/sh
# Point d'entree du conteneur de PRODUCTION. Il tourne dans l'image, jamais sur
# le poste. Son equivalent de developpement est le script `daily` de
# package.json ; les deux fabriquent leurs dates de la meme facon.
set -eu

# Pose par `ARG GIT_SHA` a la construction (Dockerfile.prod). Le `:?` refuse une
# image construite sans, plutot que de journaliser une chaine vide dans
# decisions.git_sha — ce que le point d'entree Node refuserait de toute facon.
: "${UBAC_GIT_SHA:?absent : image construite sans --build-arg GIT_SHA}"

# UN SEUL appel a `date`, et les deux valeurs en sortent. Deux appels separes
# laisseraient a minuit UTC une fenetre d'une milliseconde ou le jour de run et
# l'instant journalise tombent de part et d'autre de la limite, et l'index
# unique de `decisions` ne protegerait plus de rien.
AT=$(date -u +%FT%TZ)
RUN_DATE=${AT%T*}

echo "ubac: run_date=${RUN_DATE} at=${AT} git_sha=${UBAC_GIT_SHA}"

# Les arguments recus sont ajoutes APRES les notres, et la derniere occurrence
# d'une option gagne (src/jobs/daily-main.ts) : un rejeu se demande en passant
# `--run-date=2026-09-01` au job, sans avoir a deviner l'ordre.
exec node dist/jobs/daily-main.js \
  --run-date="${RUN_DATE}" \
  --at="${AT}" \
  --git-sha="${UBAC_GIT_SHA}" \
  "$@"
