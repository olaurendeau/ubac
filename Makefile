# Ubac — commandes via Docker Compose (pas de Node/npm sur le host).
COMPOSE ?= docker compose
DEV     ?= ./scripts/dev.sh

# Les cibles qui ont besoin de la base n'utilisent PAS $(DEV) : le wrapper passe
# --no-deps, qui empeche justement Compose de demarrer le service `db`. Elles
# appellent `compose run` directement, ce qui honore le depends_on du service
# `dev` et attend que Postgres soit sain. Voir docs/base-de-donnees.md.
DEV_DB  ?= $(COMPOSE) run --rm dev bash -c

.PHONY: help build shell ci typecheck test coverage check clean \
        db-up db-down db-push db-shell test-db coverage-db check-db

help: ## Affiche les cibles disponibles
	@awk 'BEGIN {FS = ":.*##"; printf "Cibles:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Construit l'image du service dev
	$(COMPOSE) build

shell: ## Shell interactif dans le conteneur
	$(DEV) bash

ci: ## npm ci (dépendances verrouillées dans le volume)
	$(DEV) npm ci

typecheck: ## tsc --noEmit
	$(DEV) npm run typecheck

test: ## vitest run (tests de base ignorés, voir test-db)
	$(DEV) npm test

coverage: ## vitest run --coverage
	$(DEV) npm run test:coverage

check: ci typecheck test ## ci + typecheck + test

db-up: ## Démarre le Postgres de développement et attend qu'il soit sain
	$(COMPOSE) up -d --wait db

db-down: ## Arrête le Postgres de développement, sans effacer ses données
	$(COMPOSE) stop db

# `drizzle-kit push` liste ses instructions destructrices puis les exécute : la
# confirmation n'existe que sur un terminal interactif. Sans TTY, un DROP TABLE
# passe sans question. Ce garde-fou attrape l'accident le plus probable — la
# cible recopiée dans un workflow — et rien d'autre : il ne voit pas un script
# qui ne pose pas CI. La garantie reste la règle, pas ce test. Voir
# docs/base-de-donnees.md §5.
db-push: ## Applique le schéma sur la base locale, DEPUIS LE POSTE
	@test -z "$$CI" || { \
	  echo "db-push refuse de tourner en CI : push exécute ses DROP sans confirmation hors terminal."; \
	  echo "Migrer depuis le poste. Voir docs/base-de-donnees.md, section 5."; \
	  exit 1; }
	$(DEV_DB) 'DATABASE_URL="$$UBAC_DEV_DATABASE_URL" npm run db:push'

db-shell: db-up ## psql sur la base de développement
	$(COMPOSE) exec db psql -U ubac_dev -d ubac_dev

test-db: db-push ## vitest run, base comprise (schéma appliqué au préalable)
	$(DEV_DB) 'UBAC_TEST_DATABASE_URL="$$UBAC_DEV_DATABASE_URL" npm test'

coverage-db: db-push ## vitest run --coverage, base comprise
	$(DEV_DB) 'UBAC_TEST_DATABASE_URL="$$UBAC_DEV_DATABASE_URL" npm run test:coverage'

check-db: ci typecheck test-db ## ci + typecheck + tests base comprise

clean: ## Supprime les volumes Compose, données Postgres comprises
	$(COMPOSE) down --volumes
