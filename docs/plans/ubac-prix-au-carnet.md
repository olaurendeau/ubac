# Plan : ubac-prix-au-carnet

Plan du 2026-10-01 pour `docs/specs/ubac-prix-au-carnet.md` (PR #81). Base
relue : `main` à `eed6617`. La spec fait foi ; ce plan est une hypothèse.

## État de départ, constaté

| Sujet | Où | Constat |
|---|---|---|
| Prix limite | `src/jobs/daily.ts:921`, `execute.ts:60` | `auCarnet(ordre, prices)` sur les clôtures, **après** `validate` |
| `PRICE_SANITY` | `src/core/risk.ts:284`, `daily.ts:860` | `mids: prices` et `limitPrice` = clôture (`rebalance.ts:690`) : écart nul par construction |
| Marge | `src/jobs/liquidate.ts:81`, `:277` | `MARGE_LIMITE_PCT` 0,1 %, `prixLimite` partagé avec `execute.ts` |
| Lectures Coinbase | `src/adapters/coinbase.ts:132` | six routes énumérées (`READ_ROUTES`), aucune sur le carnet |
| Rejet post-only | `src/adapters/coinbase.ts:1032`, `src/jobs/suivi.ts:74` | `REJECTED` + `reason` = codes joints par « / » ; `refusPostOnly(reason)` classe déjà exactement |
| `client_order_id` | `src/core/order-id.ts` | deux domaines (`ubac.order-id.v1`, `ubac.exit-order-id.v1`), valeurs figées |
| Annulation | `src/jobs/reconcile.ts:192`, `:434` | `ageMs > 24 h` sur `orders.created_at` |
| Ordre en base | `src/adapters/db.ts:208` | `PendingOrderRecord` porte `decisionId` (nullable), **pas** le `run_date` |
| Fixtures Coinbase | `test/adapters/fixtures/` | captures réelles chargées par `reelle()`, fabriquées par `fabriquee()` avec `_fabrique` |

**Aucun travail ouvert à reprendre** : aucune branche ni PR ne touche au prix
limite, à `PRICE_SANITY` ou à la règle des 24 h.

## Ajustements techniques, sans changement de besoin

1. **Le `run_date` d'un ordre ouvert (D5).** `PendingOrderRecord` ne le porte
   pas : la lecture des ordres en attente joint `decisions` pour le rendre.
   La spec garde « le traitement actuel » pour un ordre sans décision, mais ce
   traitement est la règle des 24 h, que le critère 19 supprime. Retenu : un
   ordre sans décision prend pour jour celui, en UTC, de son `created_at`, que
   le run écrit avec son propre instant. Même objectif, aucune règle d'âge
   conservée. À relever dans la PR de L3.
2. **Le classement du rejet (D4).** Le second essai réutilise `refusPostOnly`
   de `suivi.ts`, sans en écrire un second. S'il faut le déplacer pour éviter un
   import de `jobs/suivi.ts` par l'étape 6, il va dans `execute.ts` et
   `suivi.ts` l'importe.

## Décisions préalables

Aucune décision métier ouverte. Une étape opérateur après le déploiement de
L1 (voir « Étapes de l'opérateur »).

## Lots

### L1 — Le carnet lu, et la couche risque valide le prix qui part

**Dépend de** : PR #81 fusionnée. · **Reprend** : rien.
**Critères** : 1 à 10, 21, 22 (partie prix et sortie), 23.

**Résultat** : la production place au meilleur acheteur ou vendeur lu juste
avant, et `validate` contrôle ce prix contre le mid en direct et la clôture. La
sortie vend au meilleur vendeur. Le second essai et l'annulation ne changent
pas encore.

**Fichiers prévus**
- `src/adapters/coinbase.ts` : route `best_bid_ask` (deux `product_ids`), parseur
  Decimal, méthode de lecture sur le port d'exchange ; `READ_ROUTES` à sept.
- `src/adapters/inertes.ts` : uniquement si la lecture ne passe pas déjà par
  le port réel en `DRY_RUN`.
- `src/core/risk.ts` : `RiskContext` porte `mids` (en direct) et `closes` ;
  `priceSanity` fait les trois contrôles de D3.
- `src/jobs/daily.ts` : lecture conditionnelle à l'étape 5 ; prix au carnet
  posé sur les jambes de la production avant `validate` ; ombres à la clôture.
- `src/jobs/execute.ts` : `auCarnet` ne réécrit plus le prix ; il arrondit la
  quantité.
- `src/jobs/liquidate.ts` : `prixLimite` sur le carnet ; `MARGE_LIMITE_PCT`
  supprimé ; `SortieInput.mids` devient le carnet.
- `src/replay/engine.ts` : clôture pour `mids` et `closes`.
- Tests : `test/adapters/coinbase.test.ts`, fixture
  `test/adapters/fixtures/coinbase-best-bid-ask.json`, `test/core/risk-leg.test.ts`,
  `test/core/risk-context.test.ts`, `test/jobs/daily.test.ts`,
  `test/jobs/doubles.ts`, `test/jobs/execute.test.ts`, `test/jobs/liquidate.test.ts`,
  `test/adapters/inertes.test.ts` si `inertes.ts` bouge.
- Docs : `docs/run-quotidien.md` (étape 6.1), `docs/sortie-propre.md`,
  `docs/coinbase-lecture.md` (septième route), `docs/specs/ubac-rebalance.md`
  §7 ligne « Prix limite ».

**Diff estimé** : ~720 lignes comptées (code ~260, tests ~400, docs ~60).
Généré : la fixture, ~30 lignes, exclue.

**Validation** : `make typecheck`, `make test`, `make coverage` avec `risk.ts`
à 100 % lignes et branches ; sortie du rejeu identique (critère 9).

**Pièges**
- **La fixture est fabriquée.** Aucune capture de `best_bid_ask` n'existe : elle
  porte `_fabrique` et se charge par `fabriquee()`, forme calquée sur la
  documentation citée dans la spec. Une capture la remplacera (étape O1).
- **Les deux références ne se confondent pas.** Le mid en direct ne remplace la
  clôture nulle part ailleurs : valorisation, poids, bandes et photo restent à
  la clôture. Seuls `PRICE_SANITY` et le prix de l'ordre lisent le carnet.
- **Le prix est posé avant `validate`, pas après.** Un `auCarnet` qui
  retoucherait encore le prix rouvrirait K3. Le test du critère 6 compare
  l'ordre placé au verdict accepté.
- **Rejet à 2 % pile accepté.** `gt`, pas `gte`, comme aujourd'hui.
- **`bid >= ask`** est un carnet inexploitable, pas un prix.
- **`risk.ts` sans test = PR bloquée** (AGENTS.md).

### L2 — Le second essai, un seul, sur le rejet post-only

**Dépend de** : **L1 fusionné** (il relit le carnet et repasse par `validate`
tels que L1 les pose). · **Critères** : 11 à 16, 22 (partie étape 6), 23.

**Résultat** : une jambe rejetée par un post-only est rejouée une fois au
carnet relu, sous un identifiant du domaine `ubac.order-id-retry.v1`, et le
rapport la montre comme telle.

**Fichiers prévus**
- `src/core/order-id.ts` : troisième domaine ; `ubac.order-id.v1` intact.
- `src/jobs/daily.ts` : après le lot, relecture du carnet pour les actifs
  rejetés, `validate` sur les seules jambes rejouées, placement.
- `src/jobs/execute.ts` : `placer` réutilisé tel quel pour le second lot ;
  `refusPostOnly` éventuellement déplacé ici (ajustement 2).
- `src/jobs/suivi.ts` : import seul, si le classement est déplacé.
- `src/report/daily-report.ts`, `src/report/lexique.ts` : ligne « second
  essai », compte post-only sans doublon.
- Tests : `test/core/order-id.test.ts`, `test/jobs/daily.test.ts`,
  `test/jobs/execute.test.ts`, `test/report/daily-report.test.ts`,
  `test/jobs/suivi.test.ts` si déplacement.
- Docs : `docs/run-quotidien.md` (étape 6.3, E26 amendé).

**Diff estimé** : ~560 lignes comptées (code ~200, tests ~320, docs ~40).

**Validation** : `make typecheck`, `make test`. La valeur figée de
`ubac.order-id.v1` ne bouge pas : le diff de `test/core/order-id.test.ts` n'en
retire aucune ligne.

**Pièges**
- **Rejouer le run du jour** ne place ni premier ni second essai : la décision
  `ALREADY_RECORDED` arrête tout avant l'étape 6, et la clé primaire d'`orders`
  refuse l'identifiant du second essai. Les deux défenses se testent séparément.
- **Seul le post-only exact** est rejoué : `refusPostOnly` refuse un code mêlé
  (fonds insuffisants + post-only). Un test le fixe.
- **Les jambes rejouées partent après la dernière jambe du lot**, dans l'ordre
  reçu : une interruption laisse un préfixe connu.
- **`REBALANCE_EXECUTED` et le rapport** comptent les ordres, pas les jambes : un
  second essai placé ne doit pas faire compter deux rejets.

### L3 — Le run du jour annule les ordres des runs précédents

**Dépend de** : PR #81 fusionnée. Indépendant de L1 et L2. · **Critères** : 17
à 20, 22 (partie réconciliation), 23.

**Résultat** : tout ordre ouvert d'un `run_date` antérieur est annulé au run
suivant, quel que soit son âge ; un second run du jour n'annule rien.

**Fichiers prévus**
- `src/adapters/db.ts` : la lecture des ordres en attente rend le `run_date`
  par jointure sur `decisions` (nullable).
- `src/jobs/reconcile.ts` : `annulationsDe(orders, runDate)` ; ordre sans
  décision → jour UTC de `created_at` (ajustement 1) ; `MAX_ORDER_AGE_MS`
  supprimé.
- `src/jobs/daily.ts` : passe le `run_date` à la réconciliation, si ce n'est
  pas déjà le cas.
- Tests : `test/jobs/reconcile.test.ts`, `test/adapters/db.test.ts`,
  `test/jobs/daily.test.ts` (garde de l'étape 6 inchangé).
- Docs : `docs/reconciliation.md` §3, `docs/run-quotidien.md` (S8b),
  `docs/specs/ubac-rebalance.md` §7 ligne « 24 h ».

**Diff estimé** : ~330 lignes comptées (code ~90, tests ~200, docs ~40).

**Validation** : `make typecheck`, `make test`, **`make test-db`** (la
jointure se teste contre Postgres).

**Pièges**
- **Le second run du jour** (cas du 2026-09-28 13:44) ne doit rien annuler :
  test explicite à `run_date` égal.
- **Ne pas comparer des instants.** La règle porte sur des jours (`IsoDate`),
  pas sur `now - created_at` : c'est ce qui supprime la dépendance à l'heure de
  démarrage.
- **Le garde « aucun ordre par-dessus un ordre ouvert »** reste tel quel : une
  annulation en échec bloque toujours l'étape 6.

## Couverture des critères

| Critère | Lot | | Critère | Lot |
|---|---|---|---|---|
| 1 route `best_bid_ask` | L1 | | 13 pas de troisième essai | L2 |
| 2 parseur, carnet inexploitable | L1 | | 14 domaines `order-id` | L2 |
| 3 aucun appel si `NONE` | L1 | | 15 rejeu sans placement | L2 |
| 4 `DRY_RUN` lit le carnet | L1 | | 16 rapport du second essai | L2 |
| 5 prix au meilleur côté, arrondi | L1 | | 17 annulation sous 24 h | L3 |
| 6 prix validé = prix placé | L1 | | 18 second run du jour | L3 |
| 7 trois contrôles `PRICE_SANITY` | L1 | | 19 fin des 24 h | L3 |
| 8 carnet inexploitable → rejet, run conclu | L1 | | 20 garde de l'étape 6 | L3 |
| 9 ombres et rejeu inchangés | L1 | | 21 sortie au carnet | L1 |
| 10 `risk.ts` à 100 % | L1 | | 22 documentation | L1, L2, L3 |
| 11 second essai post-only | L2 | | 23 `typecheck` et `test` | L1, L2, L3 |
| 12 `validate` du second essai | L2 | | | |

## Vagues et sérialisation

| Vague | Lots | Condition |
|---|---|---|
| 1 | **L1**, **L3** en parallèle | PR #81 fusionnée |
| 2 | **L2** | L1 fusionné |

**Priorité si un seul worker** : L1, puis L3, puis L2. L1 rend les ordres
exécutables ; L3 supprime le blocage d'un jour sur deux ; L2 améliore le taux
de placement.

**Fichiers communs, à sérialiser par le coordinateur**

| Fichier | Ce plan | Autres travaux |
|---|---|---|
| `src/jobs/daily.ts`, `test/jobs/daily.test.ts` | L1, L2, L3 | PR #76 ; S9 et S13 (phase 3) ; Y8 (convoyeur) |
| `src/report/daily-report.ts`, `src/report/lexique.ts` | L2 | PR #76 |
| `src/adapters/db.ts` | L3 | PR #77 (Y1) ; S9 |
| `src/jobs/reconcile.ts` | L3 | Y8 |
| `docs/run-quotidien.md`, `docs/specs/ubac-rebalance.md` | L1, L2, L3 | — |

L1 et L3 se rebasent l'un sur l'autre dans l'ordre de fusion ; leurs zones de
`daily.ts` (étape 5–6 contre étape 2ter) ne se recouvrent pas.

## Étapes de l'opérateur

- **O1, après le déploiement de L1** : lancer le job une fois en `--dry-run`
  et lire dans le journal la ligne du carnet (deux paires, bid < ask). Un carnet
  inexploitable se voit là, sans ordre en jeu. La réponse brute, expurgée,
  remplace ensuite la fixture fabriquée — petit correctif hors de ces lots.
- **Entre-temps** : les ordres au carnet continuent d'être annulés par la règle
  des 24 h ou de bloquer un run, jusqu'à L3.

## Ce que ce plan ne garantira pas

Qu'un ordre au meilleur acheteur s'exécute avant le run suivant (H4), ni que le
second essai évite tout rejet. Le rapport quotidien le montrera.
