FROM node:22-bookworm

WORKDIR /workspace

# Dépendances installées au runtime via le volume du dépôt + volume nommé
# `ubac_node_modules` (voir docker-compose.yml). Pas de `npm ci` ici : le
# lockfile du worktree monté fait foi.

CMD ["bash"]
