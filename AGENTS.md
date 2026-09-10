# Consignes communes aux agents

Ce fichier est la référence commune pour Claude, Cursor, Mistral Vibe et Codex
dans ce dépôt.
`CLAUDE.md` le charge et complète uniquement les consignes propres à Claude Code.

## Projet et références

Ubac est un agent de rééquilibrage BTC / ETH / USDC via Coinbase Advanced Trade.
Le cash est exclusivement en USDC. Le projet est actuellement en phase 0 : noyau
pur et rejeu historique, sans exécution d'ordres.

- `docs/specs/ubac-phase-0.md` : périmètre et critères d'acceptation actuels ;
  prévaut sur la spécification générale pour la phase 0.
- `docs/specs/ubac-rebalance.md` : vision générale et architecture cible.
- `docs/plans/ubac-phase-0.md` : découpage proposé de l'implémentation.
- `docs/workflow-dev.md` et `docs/kit-workflow.md` : expérimentation du workflow
  et outillage de pilotage au téléphone.

## Repères dans le dépôt

- `src/core/types.ts` : vocabulaire métier et types Decimal marqués
  (`Price`, `Quantity`, `UsdcAmount`, `Weight`).
- `test/core/types.test-d.ts` : assertions de types vérifiées par TypeScript.
- `test/structure.test.ts` et `test/lint/fixtures/` : garde-fous de pureté et
  de séparation des couches, adossés à `eslint.config.js`.
- `test/budget-reporter.ts` et `docs/marge-des-delais.md` : marge de chaque test
  sous son propre delai, et la regle du delai cible plutot que global.
- `.claude/commands/` : commandes du workflow Claude Code.
- `docs/workflow-phases.md` : instructions communes de cadrage, plan, construction et revue.
- `scripts/dev.sh` : wrapper Docker Compose pour `npm` / Node dans le service
  `dev` ; aucun coordinateur maison.

Les autres modules décrits dans la spec et le plan restent à implémenter.
Ne pas confondre l'architecture cible avec le code déjà présent.

## Stack et vérification

Node.js >= 22, npm (`package-lock.json`), TypeScript strict en ESM / NodeNext,
`decimal.js`, Vitest et fast-check.

**Pas de `node` / `npm` / toolchain de build sur le host.** C'est volontaire.
Toute installation de dépendances et toute vérification passent par Docker
Compose (`docker-compose.yml`, service `dev`). Le wrapper `./scripts/dev.sh`
équivaut à `docker compose run --rm --no-deps dev …`.

```sh
docker compose build          # ou : make build
./scripts/dev.sh npm ci       # ou : make ci
./scripts/dev.sh npm run typecheck   # ou : make typecheck
./scripts/dev.sh npm test     # ou : make test
./scripts/dev.sh npm run test:coverage  # ou : make coverage
make check                    # ci + typecheck + test
```

Ne pas installer Node, npm ou Python « pour le projet » sur le Mac. `docker`
reste l'unique runtime de build/test attendu des agents. Les agents CLI
(Orca, Claude, Cursor, Vibe, Codex, `gh`) restent hors Compose. Voir
`Makefile` et `./scripts/dev.sh`.
Les imports TypeScript relatifs utilisent l'extension `.js` ; les imports de
types utilisent `import type`. Adapter les vérifications au changement et
indiquer les commandes exécutées ainsi que leurs éventuels échecs.
Le seuil de couverture de `risk.ts` est une exigence à mettre en place lors de
son implémentation ; la configuration actuelle n'impose pas encore ce seuil.

## Architecture du noyau

- `src/core/` reste pur : aucune IO, aucun accès à l'environnement, à l'horloge
  système ou à l'aléatoire. L'horloge est injectée.
- Respecter les restrictions d'imports et de globales d'`eslint.config.js` ;
  `node:crypto` n'y est admis que pour `createHash`.
- Préserver la distinction entre prix, quantités, montants USDC et poids.
- La couche risque est déterministe et ne possède aucun mode de contournement.
- En phase 0, ne pas introduire d'adapters, de jobs, de base de données ou
  d'infrastructure de production. Le rejeu valide l'implémentation, pas la
  rentabilité des stratégies.

## Workflow

Le cadrage et la planification précèdent la construction. Les instructions des
quatre phases sont dans [docs/workflow-phases.md](docs/workflow-phases.md).
Les commandes `.claude/commands/` sont des raccourcis vers ces instructions ;
Codex reçoit directement le rôle et les arguments dans sa tâche Orca.

- Orca est l'unique orchestrateur : Run, tâches, dispatches, suivi et décisions.
  Lire son guide local avec `orca skills get orchestration` avant de coordonner.
- Workers sur le Mac actuel, dans des worktrees Orca distincts ; trois workers
  simultanés maximum. Claude construit par défaut ; Cursor prend le relais si
  Claude est indisponible ; Mistral Vibe (`--agent mistral-vibe`) prend le
  relais si Cursor est aussi indisponible. Codex relit en session neuve ; si Codex est indisponible, la revue passe à
  Cursor puis Claude, en excluant toujours le moteur qui a construit le lot.
- Une étape cohérente par PR, jusqu'à **1 000 lignes ajoutées + supprimées**.
  Code, tests et documentation comptent ; fixtures générées et lockfiles sont
  exclus du plafond, avec contrôles d'intégrité et justification dans la PR.
- Le coordinateur fusionne en squash après validation et revue du dernier commit.
  Une dépendance est satisfaite après confirmation du merge, jamais au seul
  retour du worker. Les détails sont dans [docs/workflow-dev.md](docs/workflow-dev.md).
- La spec est la référence de vérité ; le plan est une hypothèse. Un ajustement
  technique nécessaire au même objectif peut être documenté sans nouveau cadrage.
  Un changement de besoin ou d'invariant passe par une décision dans Orca.
- Plafond de consommation : aucun moteur ne reçoit de dispatch au-delà de 80 %
  de sa fenêtre de quota (`orca account list --json`). Relais vers le moteur
  suivant ou attente du reset, motif « plafond 80 % ».
- Les résultats et blocages sont rapportés dans Orca. Aucun hook de notification
  ni fichier de rapport local n'est requis.

## Reponses

L'operateur est le plus souvent sur telephone. Reponses courtes. Toute question posee doit etre repondable par un chiffre :

```
1) <option>
2) <option>
```

## Regles techniques non negociables

- Aucun `number` flottant sur un prix, une quantite ou un poids. `decimal.js` obligatoire.
- Aucun secret en clair dans le depot.
- Toute operation exterieure doit etre idempotente.
- La couche `core/risk.ts` est couverte a 100 %. Une PR qui la touche sans test est bloquee.
