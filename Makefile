# Ubac — commandes via Docker Compose (pas de Node/npm sur le host).
COMPOSE ?= docker compose
DEV     ?= ./scripts/dev.sh

.PHONY: help build shell ci typecheck test coverage check clean

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

test: ## vitest run
	$(DEV) npm test

coverage: ## vitest run --coverage
	$(DEV) npm run test:coverage

check: ci typecheck test ## ci + typecheck + test

clean: ## Supprime le volume node_modules Compose
	$(COMPOSE) down --volumes
