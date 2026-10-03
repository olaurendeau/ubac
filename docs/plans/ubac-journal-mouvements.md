# Plan : ubac-journal-mouvements

Demande de l'opérateur, 2026-10-02 : dans le courrier quotidien, **un seul
tableau** pour les derniers apports, retraits et ordres, **huit lignes au
plus**. Plan établi le 2026-10-02, `main` à `5e0930b`.

## Référence

**Pas de spec dédiée**, comme pour #73 et #76 : la référence de la section est
`docs/rapport-quotidien.md` §11. La demande et les décisions ci-dessous la
modifient ; les critères J1 à J9 en tiennent lieu de critères d'acceptation.
`src/core/` n'est pas dans le périmètre.

## Décisions de l'opérateur (2026-10-02)

- **D1 (ordres retenus) = 1** : seuls les ordres **exécutés**, en totalité ou en
  partie (`filled_qty > 0`), au montant réellement exécuté. Un ordre annulé
  après une exécution partielle compte pour sa partie exécutée ; un ordre
  rejeté ou sans exécution n'apparaît pas.
- **D2 (signe d'un ordre) = 1** : vu du cash. Un achat est négatif, une vente
  positive, comme un retrait et un apport.
- **D3 (section « Ordres du jour ») = 1** : conservée telle quelle ; elle reste
  le détail du jour, rejets et ordres non exécutés compris.
- **D4 (date d'un ordre) = 1** : `settled_at`, ou `created_at` tant que l'ordre
  est ouvert (`PARTIAL`).

- **D5 (frais) = 1**, tranchée le 2026-10-03 : le **montant d'un ordre est
  `filled_qty × filled_price`, hors frais** ; les frais sont donnés dans la
  colonne Détail.

## État de départ, constaté

| Acquis (#73, #76) | Fichier | Sort |
|---|---|---|
| `latestCashFlows(limit)`, tri `occurred_at desc, id desc` | `src/adapters/db.ts` | gardée |
| Lecture non fatale `READ` / `UNREADABLE`, journalisée | `src/jobs/daily.ts` (`lireMouvements`) | étendue aux ordres |
| Section toujours visible : liste, vide, panne | `src/report/daily-report.ts` (`mouvementsSection`) | gardée, colonnes changées |
| `DERNIERS_MOUVEMENTS = 5` | `src/report/daily-report.ts` | passe à 8 |
| Délégation en DRY_RUN | `src/adapters/inertes.ts` | une délégation ajoutée |
| Contrat run → rendu (V6 ter, V8) | `test/report/contrat-run.test-d.ts` | suit le renommage |

La table `orders` porte déjà tout ce qu'il faut : `side`, `asset`,
`filled_qty`, `filled_price` (prix moyen), `fees` (USDC), `status`,
`created_at`, `settled_at`. Seuls les ordres de production y sont : les
stratégies d'ombre n'en placent aucun.

Travaux ouverts : **#90** (S13) modifie `src/jobs/daily.ts` et
`test/jobs/daily.test.ts`, les deux fichiers de ce lot : **le lot part après
le merge de #90**. #89 et #91 ne touchent aucun fichier du lot.

## Critères

- **J1.** La section « Derniers mouvements » liste les **huit** derniers
  mouvements, tous genres confondus : apports, retraits et ordres exécutés,
  du plus récent au plus ancien, quelle que soit leur date.
- **J2.** `latestExecutedOrders(limit)` lit les ordres où `filled_qty > 0`,
  triés `coalesce(settled_at, created_at) desc, client_order_id desc`, bornés à
  `limit`. Aucun montant ne passe par un flottant.
- **J3.** Le run lit au plus 8 flux et 8 ordres ; la fusion, le tri par instant
  et la coupe à 8 sont une fonction pure du rendu. À instant égal, l'ordre est
  stable et déterministe (flux avant ordre, puis identifiant).
- **J4.** Colonnes `Date | Mouvement | Montant | Detail` :
  - Date : jour UTC (`occurred_at` ; pour un ordre, D4) ;
  - Mouvement : `Apport`, `Retrait`, `Achat BTC`, `Vente ETH`… ; un ordre encore
    ouvert est suivi de `(en cours)` ;
  - Montant : USDC signé (D2), `filled_qty × filled_price` hors frais pour un
    ordre ;
  - Detail : la note du flux (tiret si absente) ; pour un ordre,
    `<qty> <actif> a <prix> USDC, frais <frais> USDC`.
- **J5.** Aucun mouvement : « Aucun mouvement enregistre. » ; la section reste.
- **J6.** Une des deux lectures en panne : le run continue, journalise
  `derniers mouvements non lus : <motif>`, la section le dit à la place du
  tableau. Pas de tableau à moitié : un journal sans ses ordres serait faux.
- **J7.** Le nombre, 8, est `DERNIERS_MOUVEMENTS` dans le rendu ; le run en
  demande autant pour chaque source.
- **J8.** Le lexique glose `mouvement` comme apport, retrait ou ordre exécuté ;
  la section « Ordres du jour » est inchangée (D3).
- **J9.** La documentation dit l'état livré : `rapport-quotidien.md` (table §9
  et §11), `run-quotidien.md` (lectures du run), `specs/ubac-convoyeur.md` K8
  si sa formulation devient fausse.

## Lot unique — L1 : le journal des mouvements

- **Dépendances** : merge de #90 (fichiers communs). Reprend #76.
- **Résultat** : le courrier quotidien montre en un tableau les huit derniers
  apports, retraits et ordres exécutés.
- **Critères couverts** : J1 à J9.
- **Fichiers prévus** :
  - `src/adapters/db.ts` — `ExecutedOrderRecord` (identifiant, côté, actif,
    quantité et prix exécutés, frais, instant, ouvert ou non) et
    `latestExecutedOrders(limit)` dans l'interface et l'implémentation ;
  - `src/adapters/inertes.ts` — délégation en lecture ;
  - `src/jobs/daily.ts` — pick de `DailyPorts`, `LatestCashFlows` porte
    `{ status: 'READ', cashFlows, orders }`, `lireMouvements` lit les deux
    sources en parallèle, une panne de l'une rend `UNREADABLE` ;
  - `src/report/daily-report.ts` — `ReportMovement` devient une union
    flux / ordre, fonction pure `journal(cashFlows, orders)` (fusion, tri,
    coupe), `DERNIERS_MOUVEMENTS = 8`, `mouvementsSection` aux quatre colonnes
    et note mise à jour ;
  - `src/report/lexique.ts` — glose de `mouvement` ;
  - tests : `test/adapters/db.test.ts` (sonde Postgres : ordres `FILLED`,
    `PARTIAL`, `CANCELLED` partiel, `CANCELLED` vide, `REJECTED` → seuls les
    trois premiers, dans l'ordre D4 ; borne), `test/jobs/daily.test.ts`
    (appels `latestCashFlows:8` et `latestExecutedOrders:8`, panne de chaque
    source, DRY_RUN), `test/report/daily-report.test.ts` (fusion de 8 flux et
    8 ordres coupée à 8, égalité d'instant, achat négatif, vente positive,
    `(en cours)`, Detail, vide, panne), `test/report/contrat-run.test-d.ts`,
    `test/adapters/inertes.test.ts`, `test/report/lexique.test.ts` si la glose
    y est figée ;
  - docs listées en J9.
- **Diff estimé** : ~400 lignes comptées. Aucune fixture générée, aucun
  lockfile.
- **Validation** :
  ```sh
  make ci && make typecheck && make test
  make test-db    # sonde Postgres de latestExecutedOrders (J2)
  ```
- **Pièges** :
  - `filled_price` peut être `null` sur une ligne ancienne : le filtre exige
    `filled_qty > 0` **et** `filled_price` non nul, sinon le montant ne se
    calcule pas.
  - `DailyOutcome.cashFlows` (flux du jour) existe déjà : ne pas réutiliser ce
    nom dans `LatestCashFlows`.
  - `MemeEnsemble<>` de V8 fait échouer `tsc` si `NonLusAttendus` n'est pas
    tenu à jour.
  - `mouvement` sert aussi dans le message du plafond de risque (« un seul
    mouvement », `lexique.ts:188`) : la nouvelle glose doit rester juste pour
    ce sens, ou ce message ne doit pas la déclencher.
  - Signe d'un ordre : `usdc()` rend déjà le signe d'un négatif (figé par
    #76) ; un test fige `-412.30 USDC` pour un achat.
  - Le rendu reste sans accent (`Detail`, `a`).
- **Décisions préalables** : D1 à D5, tranchées.

## Couverture

| Critère | Lot |
|---|---|
| J1 à J9 | L1 |

## Vagues

Une seule vague, un seul lot, après le merge de #90.
