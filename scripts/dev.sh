#!/usr/bin/env bash
# Lance une commande dans le service Compose `dev` (Node 22).
# Usage : ./scripts/dev.sh npm test
set -euo pipefail
cd "$(dirname "$0")/.."
exec docker compose run --rm --no-deps dev "$@"
