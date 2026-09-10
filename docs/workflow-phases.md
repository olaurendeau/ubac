# Instructions communes des phases

Ces instructions s'appliquent à Claude et Codex. Le coordinateur transmet le
rôle, le slug de spec et le lot (ou la PR, la base et le commit à relire).
La politique d'orchestration est dans [workflow-dev.md](workflow-dev.md).

## Cadrer

Explorer le dépôt, reformuler le besoin en trois lignes, puis poser les questions
qui changent réellement le périmètre. Questions numérotées, répondables depuis
le téléphone, cinq au maximum par passe. Challenger explicitement une hypothèse
avec une objection argumentée ; attendre la réponse aux décisions nécessaires.
Aucun code ni plan d'implémentation pendant cette phase.

Produire `docs/specs/<slug>.md` avec : besoin, périmètre inclus/exclu, décisions
prises, hypothèses challengées, critères d'acceptation vérifiables et incertitudes.
Une révision d'une spec existante est possible si le besoin porte sur sa mise à
jour. Commit `spec: <slug>`, puis rapport dans Orca.

## Planifier

Lire la spec et inspecter le code, les branches et PR existantes. Aucun code.
Conserver les acquis et rattacher les travaux ouverts avant de prévoir du neuf.
Une ambiguïté métier devient une décision préalable au lot concerné ; ne pas
réécrire la spec sans décision de l'opérateur.

Découper par résultat cohérent et testable. Le plafond est de 1 000 lignes de
diff (ajouts + suppressions), pas une cible à remplir. Inclure code, tests et
documentation. Exclure uniquement les fixtures générées et lockfiles ; estimer
leur volume séparément et préciser leur validation. Ne pas fragmenter une
fonctionnalité seulement pour rester sous l'ancienne cible de 200 lignes.
Au-delà de 1 000 lignes comptées, redécouper en résultats vérifiables.

Produire `docs/plans/<slug>.md`. Chaque lot indique :

- dépendances explicites et anciennes étapes/PR reprises ;
- résultat, périmètre de fichiers prévu et critères de spec couverts ;
- diff estimé compté et généré, commandes de validation ;
- pièges connus et décisions préalables.

Ajouter une table exhaustive critère de spec → lot et les vagues parallèles.
Le coordinateur sérialise les écritures sur des fichiers communs même si les
lots n'ont pas de dépendance métier. Commit `plan: <slug>`, rapport dans Orca.

## Construire

Claude implémente le lot attribué, avec les tests nécessaires au comportement.
Lire spec, plan et tâche Orca ; vérifier que les dépendances sont intégrées.
Utiliser le worktree et la branche attribués : ne pas créer une branche ou une
PR concurrente quand le coordinateur a confié une reprise de PR existante.
Installer les dépendances verrouillées avec `npm ci` si nécessaire avant les
vérifications ; ne pas supposer que le setup Orca les a installées.

Le périmètre de fichiers est prévisionnel. Une adaptation technique nécessaire
au même objectif est permise : documenter le motif et les fichiers ajoutés dans
le rapport. Pour une modification de besoin, d'invariant ou de dépendance,
poser une question au coordinateur via `ask`. Ne pas modifier la spec ou le plan
ni enchaîner sur le lot suivant. Le coordinateur répercute les ajustements du plan.

Exécuter le critère du lot, `npm run typecheck` et `npm test`. Si le risque est
touché, exécuter aussi `npm run test:coverage` et vérifier les 100 % lignes et
branches de `risk.ts`. Calculer le diff contre la base de PR avec
`git diff --numstat <base>...HEAD`, en ajoutant séparément les changements non
committés avant le commit. Lister les exclusions générées et leur justification.
Si le lot dépasse le plafond, demander son redécoupage au coordinateur.

Après validation, commit, push et création ou mise à jour de la PR attribuée.
Titre et description reflètent tout le lot final, y compris lors d'une reprise.
La description indique le résultat, les critères couverts, les commandes et
résultats réels, le volume compté/exclu et les doutes ou « aucun ».
Ne pas fusionner : fournir PR, base, SHA de tête et preuves au coordinateur.
Terminer par le signal de fin demandé dans le préambule Orca.

## Relire

Codex relit dans une session neuve, sans contexte de construction. Si cette
session a implémenté le changement, signaler l'incompatibilité et arrêter.

Lire les consignes communes, la spec et les critères applicables fournis par
le coordinateur, le diff base → SHA demandé, puis le code et les tests utiles.
Ne pas lire le plan ni la conversation d'implémentation. Lire les justifications
de la PR seulement après avoir formulé le verdict. Le périmètre attendu est
fourni séparément, sans raisonnement d'implémentation.

Vérifier conformité, périmètre, tests réellement exécutables, calculs Decimal,
secrets, idempotence, absence de contournement du risque et taille du diff.
Exécuter les vérifications nécessaires dans le checkout du SHA relu ; conserver
une revue en lecture seule, sans corriger le code. Un verdict favorable est
possible dès la première revue : ne pas inventer un défaut pour satisfaire un quota.

Rapport dans Orca :

```text
VERDICT : PASSE | BLOQUE
Commit relu : <SHA>
Base : <SHA>
Vérifications : <commandes et résultats>
Bloquants : <fichier:ligne et problème, ou aucun>
Non bloquants : <points utiles, ou aucun>
```

Un verdict BLOQUE est une revue menée à terme, pas une panne d'agent. Le signal
`worker_done` peut donc avoir l'outcome `succeeded` avec le verdict BLOQUE dans
le rapport. Une revue impossible (checkout ou tests inexécutables, par exemple)
utilise l'outcome `failed` ; aucun merge dans les deux cas.
