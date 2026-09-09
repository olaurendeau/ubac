# Ubac

Agent de rééquilibrage crypto à bandes, sur BTC / ETH / USDC via Coinbase Advanced Trade.

Ubac : le versant à l'ombre, celui qui garde la neige. Le système conserve toujours une réserve et ne liquide jamais complètement une position.

## Documentation

| Fichier | Contenu |
|---|---|
| `docs/specs/ubac-rebalance.md` | spécification de l'agent : stratégie, couche risque, exécution, infra, fiscalité |
| `docs/workflow-dev.md` | expérimentation du workflow de dev piloté au téléphone |
| `docs/kit-workflow.md` | mise en route du kit de commandes et du watchdog |

## Workflow de développement

Quatre phases, quatre commandes. Voir `CLAUDE.md`.

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
