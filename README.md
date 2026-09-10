# Ubac

Agent de rééquilibrage crypto à bandes, sur BTC / ETH / USDC via Coinbase Advanced Trade.

Ubac : le versant à l'ombre, celui qui garde la neige. Le système conserve toujours une réserve et ne liquide jamais complètement une position.

## Documentation

| Fichier | Contenu |
|---|---|
| `AGENTS.md` | consignes communes aux agents, repères du projet et vérifications |
| `CLAUDE.md` | chargement des consignes communes pour Claude Code |
| `docs/specs/ubac-rebalance.md` | spécification de l'agent : stratégie, couche risque, exécution, infra, fiscalité |
| `docs/plans/ubac-phase-0.md` | sept lots restants et reprise des PR existantes |
| `docs/workflow-phases.md` | instructions communes de cadrage, plan, construction et revue |
| `docs/base-de-donnees.md` | schéma Postgres, base locale Compose, migration depuis le poste |
| `docs/workflow-dev.md` | expérimentation du workflow de dev piloté au téléphone |
| `Makefile` | raccourcis `make test`, `make check`, etc. via Compose |
| `Dockerfile` / `docker-compose.yml` | env de build/test Node 22 (pas de Node sur le host) |
| `scripts/dev.sh` | wrapper `docker compose run …` pour npm/typecheck/test |

## Workflow de développement

Orca coordonne les tâches et worktrees sur le Mac : Claude construit par défaut,
Cursor puis Mistral Vibe le relaie si indisponible et Codex relit en session
neuve. Le coordinateur fusionne après validation.
Une étape cohérente par PR, jusqu’à 1 000 lignes de diff hors fixtures générées
et lockfiles. Voir `AGENTS.md` et `docs/workflow-phases.md`.

Raccourcis Claude (les mêmes instructions sont accessibles à Cursor, Mistral
Vibe et Codex) :

```
/cadrer      interroge et challenge le besoin, produit une spec
/planifier   découpe en étapes vérifiables
/construire  implémente UNE étape, ouvre une PR
/relire      valide le diff contre la spec, en session neuve
```

## État

Phase 0 : `core` et tests. Aucun ordre n'est passé tant que la phase 3 n'est pas atteinte.

## Paramètres

Cible 40 % BTC / 30 % ETH / 30 % USDC. Bande cash à 20 % relatif, bande ratio BTC/ETH à 30 %. Cash en USDC exclusivement, jamais en EUR.
