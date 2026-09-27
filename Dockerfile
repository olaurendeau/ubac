FROM node:22-bookworm

WORKDIR /workspace

# jq : test/ci/deploiement.test.ts execute les etapes du job deploy telles que
# ci.yml les ecrit, et le runner de la chaine l'a deja.
RUN apt-get update \
  && apt-get install -y --no-install-recommends jq \
  && rm -rf /var/lib/apt/lists/*

# Dépendances installées au runtime via le volume du dépôt + volume nommé
# `ubac_node_modules` (voir docker-compose.yml). Pas de `npm ci` ici : le
# lockfile du worktree monté fait foi.

CMD ["bash"]
