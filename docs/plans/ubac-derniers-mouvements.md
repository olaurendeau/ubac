# Plan : ubac-derniers-mouvements

Demande de l'opérateur, 2026-09-28 : la section « Derniers apports » du rapport
quotidien (#73) montre les trois derniers apports ; il veut plutôt voir **les
cinq derniers mouvements, apports et retraits**. Plan établi le 2026-09-28,
`main` à `f5e3721`.

## Référence

**Pas de spec dédiée.** #73 n'en avait pas non plus : sa référence est
`docs/rapport-quotidien.md` §11, qui tient lieu de spec pour la section. La
demande ci-dessus est la décision de l'opérateur qui la modifie ; les critères
M1 à M8 ci-dessous la traduisent et tiennent lieu de critères d'acceptation.
Aucun invariant du noyau n'est touché : `src/core/` n'est pas dans le
périmètre.

## État de départ, constaté

Ce que #73 a livré et que le lot **garde tel quel** :

| Acquis | Fichier | Gardé |
|---|---|---|
| Lecture à l'étape 4bis, avant toute écriture | `src/jobs/daily.ts` (`lireApports`) | oui, renommée |
| Panne non fatale : `{ status: 'UNREADABLE', reason }`, journalisée | `src/jobs/daily.ts` | oui |
| Section toujours visible : liste, vide, panne | `src/report/daily-report.ts` (`apportsSection`) | oui, trois cas conservés |
| Tri `occurred_at` décroissant départagé par `id` | `src/adapters/db.ts` (`latestDeposits`) | oui |
| Conversion d'une ligne, sans flottant | `cashFlowRecord()` dans `db.ts` | réutilisée |
| Délégation en DRY_RUN | `src/adapters/inertes.ts` | oui, renommée |
| Contrat run → rendu (V6 ter, V8) | `test/report/contrat-run.test-d.ts` | oui, renommé |

Ce qui **change** : le filtre SQL `amount_usdc > 0` disparaît, le nombre passe
de 3 à 5, la section et ses messages parlent de mouvements, le signe du
montant distingue l'apport du retrait (D1 = 2), l'entrée de lexique `apport`
devient `mouvement`.

Travaux ouverts : **#75** (`plan: ubac-convoyeur`) ne touche que
`docs/plans/ubac-convoyeur.md`, aucun fichier commun avec ce lot. Il cite
« Derniers apports » et « N9 partiellement fait par #73 » (lignes 30, 186, 829
du diff) : à corriger dans #75 si elle n'est pas fusionnée avant, sinon par le
lot L1. La branche `olaurendeau/ubac-derniers-apports` est celle de #73,
déjà fusionnée ; rien à reprendre.

## Critères

- **M1.** La section s'intitule « Derniers mouvements » et liste les **cinq**
  dernières lignes de `cash_flows`, apports et retraits confondus, du plus
  récent au plus ancien, quelle que soit leur date.
- **M2.** Le tri et la borne sont dans la requête : `latestCashFlows(limit)`
  trie `occurred_at desc, id desc`, borne à `limit`, sans filtre de signe.
  Aucun montant ne passe par un flottant.
- **M3.** Chaque ligne donne date UTC, montant **signé** en USDC (`1000.00
  USDC` pour un apport, `-300.00 USDC` pour un retrait), note (tiret si
  absente). Pas de colonne Type (D1 = 2).
- **M4.** Aucun mouvement : « Aucun mouvement enregistre. » ; la section reste.
- **M5.** Lecture en panne : le run continue, journalise
  `derniers mouvements non lus : <motif>`, et la section le dit à la place de la
  liste, motif échappé.
- **M6.** Le nombre, 5, est `DERNIERS_MOUVEMENTS` dans le rendu ; le run en
  demande autant à la base.
- **M7.** Le lexique glose `mouvement` (apport ou retrait) en entrée fixe, à la
  place d'`apport` ; le rendu reste sans accent.
- **M8.** La documentation dit l'état livré : `rapport-quotidien.md` (table §9
  et §11), `run-quotidien.md`, et dans `specs/ubac-convoyeur.md` K8, la ligne
  115 et N9 (les retraits sont désormais au rapport ; reste l'origine).

## Lot unique — L1 : Derniers mouvements

- **Dépendances** : aucune. Reprend #73.
- **Résultat** : le courrier quotidien montre les cinq derniers flux, apports et
  retraits, le signe du montant les distinguant.
- **Critères couverts** : M1 à M8.
- **Fichiers prévus** :
  - `src/adapters/db.ts` — `latestDeposits` → `latestCashFlows`, filtre retiré,
    JSDoc de l'interface et en-tête du module ;
  - `src/adapters/inertes.ts` — délégation renommée ;
  - `src/jobs/daily.ts` — pick de `DailyPorts`, `LatestDeposits` →
    `LatestCashFlows` (`{ status: 'READ', cashFlows }`), `lireApports` →
    `lireMouvements`, champ `latestDeposits` → `latestCashFlows`, passage au
    rendu ;
  - `src/report/daily-report.ts` — `ReportDeposit(s)` → `ReportMovement(s)`,
    `DailyReportInput.deposits` → `movements` (obligatoire),
    `DERNIERS_APPORTS = 3` → `DERNIERS_MOUVEMENTS = 5`, `apportsSection` →
    `mouvementsSection` avec tableau `Date | Montant | Note` inchangé et note
    « Les 5 plus recents au plus, du plus recent au plus ancien, quelle que soit
    leur date. » ; `usdc()` existant rend le signe ;
  - `src/report/lexique.ts` — entrée `apport` → `mouvement` ;
  - tests : `test/adapters/db.test.ts` (sonde Postgres : six flux dont deux
    retraits, le plus récent étant un retrait → les cinq plus récents dans
    l'ordre ; vide), `test/jobs/daily.test.ts` (harnais, appel
    `latestCashFlows:5`, un retrait porté jusqu'au courrier, panne, DRY_RUN),
    `test/report/daily-report.test.ts` (rendu ligne à ligne, section et lexique,
    ordre reçu apport/retrait, vide, panne, position avant Lexique),
    `test/report/contrat-run.test-d.ts`, `test/adapters/inertes.test.ts`,
    `test/report/lexique.test.ts` si le terme y est cité ;
  - docs listées en M8.
- **Diff estimé** : ~250 lignes comptées (renommages majoritaires ; #73 en
  faisait 389). Aucune fixture générée, aucun lockfile.
- **Validation** :
  ```sh
  make ci && make typecheck && make test
  make test-db    # sonde Postgres de latestCashFlows (M2)
  ```
- **Pièges** :
  - `DailyOutcome` porte déjà un champ `cashFlows` (les flux du jour) : le
    nouveau champ s'appelle `latestCashFlows`, pas `cashFlows`.
  - `MemeEnsemble<>` de V8 fait échouer `tsc` si `NonLusAttendus` garde
    l'ancien nom.
  - Le compte d'entrées fixes du lexique (28) et le total (29) ne bougent pas :
    une entrée est remplacée, pas ajoutée.
  - Vérifier que `usdc()` rend bien le signe d'un négatif (`-300.00 USDC`) :
    un test de rendu le fige.
- **Décisions préalables** :
  - **D1 (affichage d'un retrait)** — **tranchée le 2026-09-28 : 2**, montant
    signé seul, sans colonne Type.

## Couverture

| Critère | Lot |
|---|---|
| M1 à M8 | L1 |

## Vagues

Une seule vague, un seul lot. Aucun fichier commun avec #75.
