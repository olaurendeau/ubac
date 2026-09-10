# Workflow de développement avec Orca

Version 2 · 2026-09-10

## Objectif et responsabilités

Décrire et piloter un besoin depuis le téléphone, puis suivre dans Orca le
cadrage, le plan, les boucles construction/revue et les décisions nécessaires.
La spec reste la référence ; le plan organise le travail sans figer chaque fichier.
Les [instructions des phases](workflow-phases.md) sont communes aux moteurs.

Orca desktop et ses workers tournent sur le Mac actuel. Le mobile utilise le
pairing et le Relay Orca pour le suivi à distance. La VM est reportée.
GitHub reste la surface de PR ; Orca porte les tâches, les messages et les gates.
Aucun secret de production n'est nécessaire au développement de la phase 0.

| Rôle | Responsabilité |
|---|---|
| Opérateur | Besoin, arbitrages métier, décisions bloquantes |
| Coordinateur dans Orca | Run, dépendances, dispatches, suivi, reprises et intégration |
| Claude ; Cursor puis Mistral Vibe en relais | Construction ou correction d'un lot, tests et PR |
| Codex, session neuve ; Cursor puis Claude en relais | Revue indépendante du diff contre la spec |

Le coordinateur peut être Claude ou Codex selon la session de pilotage ; les
modèles restent ceux configurés dans Orca. Trois workers actifs au maximum,
revues comprises. Aucun sous-agent hors Orca pour remplacer un worker supervisé.

## Relais Claude → Cursor → Mistral

### Relais de revue

Codex relit par défaut. Si Codex est indisponible — quota, plafond 80 %, service
ou accès — la revue passe au premier moteur disponible de la chaîne Codex →
Cursor → Claude, **en excluant le moteur qui a construit le lot**. Un lot
construit par Cursor est donc relu par Codex ou par Claude, jamais par Cursor.
Si la chaîne est épuisée parce que le seul moteur restant est le constructeur,
la revue attend le reset annoncé plutôt que de perdre son indépendance.

Le relecteur travaille en session neuve, dans un checkout de revue distinct,
sans contexte de construction, et reçoit le même dossier : spec, critères
applicables, périmètre attendu, base et SHA. Le relais est autorisé sans nouvelle
validation humaine ; le coordinateur enregistre moteur et motif dans Orca.

### Plafond de consommation à 80 %

Le crédit Claude n'est jamais consommé en entier. Avant chaque dispatch, le
coordinateur lit les quotas réels :

```sh
orca account list --json   # result.rateLimits.<provider>.session|weekly.usedPercent
```

Règle : si `session.usedPercent` ou `weekly.usedPercent` d'un moteur atteint
**80 %**, ce moteur ne reçoit plus de nouveau dispatch. Le coordinateur relaie
vers le moteur suivant autorisé, ou attend le `resetsAt` annoncé. Un worker déjà
lancé n'est pas interrompu par le franchissement du seuil : il termine son lot,
et le seuil bloque seulement le dispatch suivant.

Le seuil s'applique moteur par moteur, Codex compris : une session de revue à
100 % ne se contourne pas, elle attend son reset ou un moteur de revue de repli.
Le coordinateur consomme lui aussi du quota ; en compter la part avant d'ouvrir
un troisième worker. Ce plafond est une réserve délibérée, pas une panne : il
autorise le relais sans nouvelle validation humaine, au même titre qu'une
indisponibilité, et le motif enregistré est « plafond 80 % ».


Claude est le constructeur par défaut. Si son quota, son service ou son accès
est indisponible, le coordinateur peut reprendre le lot avec Cursor, sans nouvelle
validation humaine : ce relais est autorisé pour ce projet. Si Cursor est à son
tour indisponible (quota, service ou accès), le même type de relais vers
Mistral Vibe (`--agent mistral-vibe`) est autorisé. Un refus de revue ou une
erreur d'implémentation ne déclenche pas un changement automatique de moteur.

Avant chaque relais, vérifier que l'ancien agent a terminé ou a été arrêté de
façon confirmée ; un dispatch abandonné ou une connexion perdue ne suffit pas.
Inspecter le travail et conserver le worktree, la branche et la PR. Reprendre
via un nouveau dispatch Orca, en enregistrant ancien/nouveau moteur et motif.
Si la tâche nomme explicitement un moteur et ne peut pas être modifiée, créer
une tâche de remplacement avec référence à l'ancienne, qui reste clôturée en
échec ou bloquée, sans la présenter comme implémentée. Raccorder les
dépendances à la nouvelle intégration.

Cursor puis, le cas échéant, Mistral reçoivent les mêmes instructions communes,
critères et limites de taille. Les corrections du lot restent attribuées au
moteur de construction courant jusqu'à intégration ; ne pas rebasculer au
milieu du lot au seul retour de disponibilité d'un moteur amont. Les lots
suivants repartent avec Claude par défaut. Codex conserve la revue indépendante.

Utiliser le modèle déjà configuré pour Cursor ou Vibe, sans imposer de modèle
ni modifier le forfait, les paramètres de facturation ou activer de dépassement
payant. Si Mistral atteint sa limite, réclame un achat ou échoue à
l'authentification, bloquer et rapporter ; aucun troisième relais automatique
n'est prévu. Le cycle de validation note les moteurs réellement utilisés.

## Étapes et taille

Cadrer, planifier, construire, relire, puis intégrer et rapporter. Le cadrage et
le plan n'écrivent pas de code. Une étape produit un résultat cohérent et une PR.
Elle peut toucher plusieurs fichiers et contenir jusqu'à **1 000 lignes ajoutées
+ supprimées**, code, tests et documentation compris. Ce plafond n'est pas une
cible minimale. Fixtures générées et lockfiles sont exclus, avec volume séparé,
justification et vérifications d'intégrité ; leur changement reste relu.

Le plan donne pour chaque lot les critères de spec, dépendances, fichiers prévus,
estimation et validations mécaniques. Un ajustement technique au même objectif
est documenté, sans bloquer sur une liste de fichiers devenue inexacte. Le
coordinateur actualise le plan ; un changement de besoin demande une décision.

## Boucle native Orca

Charger `orca skills get orchestration` et au besoin `--full`, correspondant à
la version installée. Employer `task-create`, `worker-start` et les messages
natifs. Un Run est un espace de coordination, pas un ordonnanceur autonome :
le coordinateur agent pilote explicitement les tâches. Les anciennes commandes
`coordinator-start` et `coordinator-stop` sont retirées, ne pas les employer.

1. Créer ou reprendre un Run. Inspecter tâches, dispatches, PR et branches avant
   de lancer du travail ; une reprise conserve les identités déjà établies.
2. Pour chaque lot, prévoir construction, revue et intégration séparées.
   La construction dépend des tâches d'intégration des lots prérequis. La revue
   dépend de la construction ; l'intégration dépend d'une revue favorable.
   Une tâche terminée n'implique pas que sa PR est fusionnée.
3. Attribuer un worktree Orca distinct à chaque lot, basé sur la branche cible
   actualisée. Une PR reprise garde sa branche.    Lancer le constructeur via `worker-start --agent claude` (ou `--agent cursor`,
   puis `--agent mistral-vibe` pour les relais autorisés),
   avec objectif, contraintes, propriété des fichiers et preuves attendues.
   Utiliser `--setup run` pour les nouveaux worktrees. `make ci` doit être
   terminé avant les vérifications, même si Orca lance le setup en parallèle
   de l'agent. Node/npm ne sont pas sur le host.
4. Lancer les lots indépendants dans la limite de trois workers. Sérialiser les
   lots écrivant les mêmes fichiers. Recontrôler les collisions si un worker
   annonce une extension de fichiers ; ne pas lancer un second éditeur concurrent.
5. Consommer les messages avec `check --wait`, par fenêtres de 60 secondes maximum.
   Traiter questions et résultats, puis acquitter toute la livraison. Valider
   chaque fin contre le dispatch attendu ; les workers suivent les IDs, commandes
   et obligations du préambule injecté, sans fabriquer de signal de fin externe.
6. À la fin de la construction, lancer une session Codex neuve sur le commit de
   PR dans un checkout de revue distinct. Lui transmettre la spec, les critères
   applicables, le périmètre attendu, la base et le SHA ; exclure plan et historique
   de construction. Ne pas réutiliser cette session pour construire ou corriger.
7. Verdict BLOQUE : attribuer les corrections au constructeur du lot sur la même
   branche, puis
   nouvelle revue Codex en session neuve. Après deux cycles construction/revue
   infructueux, ouvrir une gate. Une panne de revue ne vaut pas refus métier ;
   conserver la PR et reprendre seulement la revue après diagnostic.
8. Intégrer selon les conditions ci-dessous. Rapporter résultat, preuve et blocage
   dans Orca. Après chaque worker terminé, réutiliser explicitement son terminal
   pour un dispatch compatible immédiat, ou appeler `worker-release`. Ne retenir
   un terminal vivant que sur demande de l'opérateur.

Une attente vide est un point de contrôle. Inspecter `worker-show`, `worker-read`
et `worker-list` et suivre les instructions de récupération de la version locale.
Une absence de sortie ou de connexion n'est pas une preuve de mort : ne pas
relancer en doublon, arrêter, abandonner ou libérer sur cette seule observation.
Conserver les états inconnus comme tels jusqu'à clarification. Aucun watchdog
fondé sur un marqueur de fichier, aucun cron de développement.

Une question de worker passe par `ask` puis `reply`. Si elle nécessite l'opérateur,
le coordinateur ouvre une gate de décision et attend sa réponse ; il ne la résout
pas par défaut. Les lots indépendants peuvent continuer. Les résumés restent
courts : fait, bloqué, décision attendue, avec lien de PR et preuves accessibles.

## Intégration et reprise des PR

L'intégration appartient au coordinateur, qui peut la confier à une tâche dédiée.
Elle est automatique quand toutes les conditions sont démontrées :

- dernier SHA de tête et SHA de base identiques à ceux de la revue PASSE ;
- critères du lot, typecheck et tests réussis ; couverture risque conforme si
  concernée ; checks GitHub existants terminés avec succès (aucun check configuré
  ne remplace ni n'annule les vérifications locales) ;
- aucun conflit ni gate en attente ; diff compté sous le plafond.

Sérialiser les merges. Si la base ou la tête a changé, actualiser la branche,
relancer les validations et une revue neuve avant intégration. Ne pas contourner
les protections GitHub. Fusionner en squash, en contraignant la tête attendue
avec `gh pr merge --squash --match-head-commit <SHA> <PR>`, puis vérifier que l'état
GitHub est réellement `MERGED` avant de débloquer les dépendances. Un code de
sortie ambigu ne suffit pas ; inspecter l'état avant toute répétition.

Les PR existantes sont reprises, pas clôturées par la migration. Actualiser titre,
corps et périmètre vers le lot complet après inspection du diff et des revues
antérieures. Les branches non intégrées restent disponibles ; aucune suppression,
aucun pruning global et aucun reset du suivi Orca pendant la migration.

## Validation de l'expérimentation

Le [kit Orca](kit-workflow.md) décrit le lancement et le cycle à blanc. Exiger
une preuve du refus d'un défaut, de sa correction, d'un merge vers une branche
de test, de l'absence de doublon et de la libération des workers. La réception
sur téléphone doit être confirmée par l'opérateur, pas déduite du retour API.

Après trois à cinq cycles : mesurer interventions humaines, blocages silencieux,
utilité du cadrage et défauts réels détectés en revue. Aucun quota de refus : une
revue favorable dès le premier passage n'est pas une preuve de complaisance.
Les notifications de développement passent exclusivement par Orca ; les besoins
ntfy/Brevo du produit restent décrits dans sa spec et sont hors de cette migration.
