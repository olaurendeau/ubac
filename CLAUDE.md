# Conventions du projet

## Workflow

Le developpement suit quatre phases, chacune avec sa commande. Ne saute jamais une phase.

| Phase | Commande | Interdit |
|---|---|---|
| Cadrage | `/cadrer` | ecrire du code |
| Plan | `/planifier` | ecrire du code |
| Implementation | `/construire` | faire plus d'une etape |
| Revue | `/relire` | tourner dans la session qui a implemente |

La spec (`docs/specs/`) est la reference de verite. Le plan (`docs/plans/`) est une hypothese, pas un contrat.

## Rapport de fin de session

Avant de terminer, ecris `.claude/last-report.md` avec exactement trois lignes :

```
Fait : <une phrase>
Bloque : <une phrase, ou "rien">
Decision attendue : <une phrase, ou "aucune">
```

Ce fichier est pousse sur le telephone de l'operateur par le hook Stop. Il le lit en marchant. Pas de markdown, pas de liste, pas de preambule. Sois factuel : si quelque chose a echoue, dis-le en premier.

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
