# Ubac : le prix limite lu au carnet, et l'ordre de la veille annulé

Cadrage du 2026-10-01. Remplace, pour l'exécution, trois lignes de
`docs/specs/ubac-rebalance.md` §7 (« Prix limite : mid ± 0,1 % », « Annuler tout
ordre limit non exécuté datant de plus de 24 h ») et les critères 20, 26 (pour
le seul rejet post-only) et 35 de `docs/specs/ubac-phase-3.md`. Ne touche ni aux
stratégies, ni aux bandes, ni aux seuils de la couche risque.

## Besoin

Depuis le 2026-09-28, le déclencheur A propose chaque jour deux achats (BTC et
ETH) acceptés par la couche risque, et aucun n'a abouti. Un rééquilibrage
accepté doit se traduire par des ordres qui ont une chance réelle de
s'exécuter : posés sur le carnet tel qu'il est au moment du placement, et
renouvelés chaque jour tant que l'écart persiste.

## Constat (relu le 2026-10-01 sur `main` à `eed6617`)

| Run | Ordres | Ce qui s'est passé |
|---|---|---|
| 2026-09-28 13:44 | aucun transmis | second run du jour : décision `ALREADY_RECORDED` (E24), comportement voulu |
| 2026-09-29 | 2 rejetés | `INVALID_LIMIT_PRICE_POST_ONLY` sur BTC et ETH |
| 2026-09-30 | 2 rejetés | idem |
| 2026-10-01 | 2 placés | au carnet, non exécutés à la relecture |

- **K1. Le « mid » est la clôture de la veille.** `src/jobs/daily.ts:921`
  appelle `auCarnet(ordre, prices)`, et `prices` vient de `closingPrices`
  (ligne 789). Le 29/09, limite BTC 83 373,28 = clôture 83 456,74 × 0,999, au
  centime. Le choix est documenté (`docs/run-quotidien.md`, étape 6.1) mais
  contredit le §7 et le §6 (« Écart au **prix marché** ») : aucune lecture du
  carnet n'existe dans le dépôt.
- **K2. Conséquence.** Si le marché de 05:00 UTC est plus de 0,1 % sous la
  clôture, l'achat croiserait : rejet post-only (29/09, 30/09). S'il est
  au-dessus, l'ordre se pose sous le marché et n'est exécuté que sur un repli
  (01/10). Aucun des deux cas ne rééquilibre.
- **K3. `PRICE_SANITY` ne contrôle rien.** `validate` reçoit `mids: prices`
  (`daily.ts:860`) et des jambes dont le `limitPrice` est la clôture
  (`rebalance.ts:690`) : l'écart vaut 0 par construction. `auCarnet` réécrit
  ensuite le prix **après** la couche risque : le prix envoyé n'est validé par
  personne.
- **K4. L'ordre de la veille peut bloquer le run du jour.** La réconciliation
  n'annule que les ordres de **strictement plus de 24 h**
  (`src/jobs/reconcile.ts:192`). Le job démarre entre 05:01 et 05:08 selon les
  jours : un run parti plus tôt que la veille trouve des ordres de 23 h 5x,
  ne les annule pas, et l'étape 6 ne place rien par-dessus (`daily.ts:776`).
  Le rééquilibrage ne repart alors qu'un jour sur deux.
- **K5. La sortie partage le défaut.** `src/jobs/liquidate.ts` calcule ses
  ventes par `prixLimite(side, mid)` (marge `MARGE_LIMITE_PCT` = 0,1 %) sur un
  `mids` fourni par l'appelant. Elle reste verrouillée (`VERROUILLE`).

## Ce que dit la documentation Coinbase (vérifiée le 2026-10-01)

`GET /api/v3/brokerage/best_bid_ask?product_ids=BTC-USDC&product_ids=ETH-USDC`,
clé de scope *view* — celle d'Ubac suffit. Réponse :
`{ pricebooks: [{ product_id, bids: [{ price, size }], asks: [{ price, size }], time }] }`,
grandeurs en chaînes.
[get-best-bid-ask](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/products/get-best-bid-ask)

## Réponses de l'opérateur (2026-10-01)

| Question | Réponse |
|---|---|
| Q1. Sur quel prix poser l'ordre | **2** — meilleur acheteur à l'achat, meilleur vendeur à la vente, lus en direct |
| Q2. Rejet post-only dans le run | **2** — relire le carnet et réessayer **une seule fois** |
| Q3. Suivre l'ordre pendant le run | **1** — non : l'ordre reste au carnet, le run suivant l'annule et recommence |
| Q4. `PRICE_SANITY` | **1** — limite comparée au mid en direct **et** mid en direct comparé à la clôture, 2 % chacun |
| Q5. La sortie (`liquidate.ts`) | **1** — même correctif |
| Q6. Ordres de la veille encore ouverts | **1** — annulés au run suivant quel que soit leur âge |

## Périmètre

### Inclus

- Une septième lecture Coinbase, `best_bid_ask`, sur les deux paires USDC, avec
  son parseur Decimal et sa fixture capturée.
- Le prix des jambes de la **production** posé sur ce carnet **avant**
  `validate`, et `PRICE_SANITY` refait sur le carnet et la clôture.
- Un second essai, unique, après un rejet post-only, sous un `client_order_id`
  distinct.
- L'annulation, par la réconciliation, de tout ordre ouvert d'un `run_date`
  antérieur, quel que soit son âge.
- La sortie : ventes au meilleur vendeur lu au carnet. Elle reste verrouillée.
- Le rapport : le second essai se lit comme tel.
- Mise à jour de `docs/run-quotidien.md`, `docs/reconciliation.md`,
  `docs/sortie-propre.md` et des deux lignes du §7 de `ubac-rebalance.md`, qui
  renvoient ici.

### Exclu explicitement

- Suivre ou recaler l'ordre pendant le run (Q3) : aucun sondage, aucune attente.
- Tout ordre taker, au marché ou IOC : le post-only reste la seule forme.
- Le prix des **ombres** : elles ne placent rien, leurs jambes restent à la
  clôture, comme le rejeu.
- Le minimum de jambe (200 USDC), la carence sur apport, les bandes, les cibles.
- L'heure de déclenchement du job.
- Le déverrouillage de la sortie.

## Décisions

### D1 — Le carnet est lu une fois, après les décisions, avant la validation

La lecture a lieu à l'étape 5, **seulement si** la production rend au moins une
jambe : un jour `NONE` n'ajoute ni appel ni mode de panne. Un seul appel couvre
les deux paires. C'est une lecture : elle a lieu pour de vrai en `DRY_RUN`,
comme les autres.

Un carnet inexploitable — appel en échec, paire absente, côté vide, prix non
fini ou nul, `bid >= ask` — ne fait pas échouer le run. La production n'a alors
pas de mid pour l'actif concerné, et la couche risque la rejette en
`PRICE_SANITY` (« aucun prix de référence »), motif dans `decisions`, dans le
journal et dans le rapport. Le run conclut.

### D2 — Achat au meilleur acheteur, vente au meilleur vendeur, sans marge

`limitPrice = best bid` pour un `BUY`, `best ask` pour un `SELL`. Le post-only
garantit déjà que l'ordre ne croise pas ; la marge de 0,1 % ne protégeait de
rien et éloignait l'ordre de l'exécution. Arrondi au pas de 0,01 USDC **en
s'éloignant du mid**, par précaution. `MARGE_LIMITE_PCT` disparaît ; `prixLimite`
prend le carnet et non plus un mid.

Le mid en direct vaut `(best bid + best ask) / 2`. Il ne sert qu'au contrôle.

### D3 — La couche risque valide le prix qui part

La jambe de production entre dans `validate` avec son prix au carnet. La
quantité reste calculée par `toOrder` (`amount / limitPrice`) puis arrondie à
1e-8 vers le bas par `auCarnet`, qui ne touche plus au prix. Le montant validé
est donc le montant engagé, à l'arrondi près.

`RiskContext` porte deux références par actif : le mid en direct et la clôture.
`PRICE_SANITY` rejette si :

1. la référence en direct manque ou n'est pas strictement positive ;
2. `|limite − mid| / mid > 2 %` ;
3. `|mid − clôture| / clôture > 2 %` — garde contre un carnet aberrant.

Les ombres et le rejeu passent la clôture pour les deux références : leur
verdict ne change pas. `risk.ts` reste couvert à 100 % lignes et branches.

### D4 — Un second essai, un seul, sur le seul rejet post-only

Une jambe rejetée par l'exchange avec un motif `INVALID_LIMIT_PRICE_POST_ONLY`
— et aucun autre — est rejouée **une fois** dans le run :

- le carnet de cet actif est relu ;
- la jambe, avec son nouveau prix, repasse par `validate`, seule ;
- refusée, elle n'est pas placée et le motif est journalisé ;
- acceptée, elle est écrite `PENDING` puis placée comme la première ;
- rejetée de nouveau, elle reste rejetée : pas de troisième essai.

Le second essai porte un `client_order_id` d'un **domaine distinct**
(`ubac.order-id-retry.v1`), mêmes quatre composantes. `ubac.order-id.v1` ne
change pas d'un octet, et la valeur figée du test reste la même. La clé
primaire d'`orders` et la décision `ALREADY_RECORDED` protègent le second essai
du rejeu exactement comme le premier.

Les jambes sont rejouées après la dernière jambe du lot, dans l'ordre reçu :
une interruption laisse toujours un préfixe connu.

### D5 — Le run du jour annule les ordres des runs précédents

La réconciliation rend à annuler tout ordre ouvert dont le `run_date` (par
`decision_id`) est **antérieur** au `run_date` du run en cours, quel que soit
son âge. Un ordre du même `run_date` — second run du jour — n'est jamais
annulé. La règle des 24 h disparaît : elle est couverte par la nouvelle.

Un ordre sans décision rattachée (cas `PENDING` orphelin) garde le traitement
actuel de la réconciliation. Une annulation qui échoue laisse l'ordre ouvert,
et l'étape 6 ne place toujours rien par-dessus : ce garde ne change pas.

### D6 — La sortie lit le même carnet

`SortieInput.mids` devient le carnet des deux paires. Chaque cession vend au
meilleur vendeur. Le verrou `VERROUILLE` et le domaine `ubac.exit-order-id.v1`
ne changent pas.

## Hypothèses challengées

### H1 — « Mid − 0,1 % protège l'ordre »

Non : le post-only protège l'ordre. La marge le place environ 80 USD sous le
meilleur acheteur sur le BTC, ce qui revient à n'acheter que sur un repli.
Retenu : D2.

### H2 — « Le run suivant annule l'ordre de la veille »

Faux à quelques minutes près (K4) : la règle des 24 h stricts et un horaire de
démarrage variable bloquent un jour sur deux. Retenu : D5.

### H3 — « `PRICE_SANITY` borne le prix envoyé »

Faux aujourd'hui (K3) : il compare la clôture à elle-même, et le prix est
réécrit après lui. Retenu : D3.

### H4 — « Au meilleur acheteur, l'ordre s'exécute »

Pas garanti. Dans un marché qui monte toute la journée, l'ordre reste au carnet
et le run suivant recommence au nouveau prix. C'est accepté (Q3 = 1) et se lit
dans le rapport. Les exécutions partielles suivent déjà le §7.

## Critères d'acceptation

### Lecture du carnet

1. `CoinbaseRoute` compte une septième route, `best_bid_ask`, et `READ_ROUTES`
   la liste ; le test de surface des routes est mis à jour, et aucune route
   d'écriture n'apparaît.
2. Le parseur rend, par paire, `bid` et `ask` en `Price` (Decimal), à partir
   d'une fixture capturée sur la vraie API. Chaîne non numérique, côté vide,
   paire absente ou `bid >= ask` donnent « carnet inexploitable » pour l'actif,
   jamais une exception non typée. Testé cas par cas.
3. Un run dont la production rend `NONE` n'appelle pas `best_bid_ask`. Sonde
   sur le transport de test.
4. En `DRY_RUN`, le carnet est lu pour de vrai, et les ordres restent `RETENU`.

### Prix et couche risque

5. Une jambe `BUY` de production part à `best bid`, une `SELL` à `best ask`,
   arrondis au centime en s'éloignant du mid. Testé sur les deux sens, avec un
   carnet dont les prix ont plus de deux décimales.
6. `validate` reçoit la jambe à son prix au carnet : le `limitPrice` de
   l'ordre placé est égal à celui que la couche risque a accepté. Sonde de bout
   en bout sur `runDaily`.
7. `PRICE_SANITY` rejette : référence absente ; limite à plus de 2 % du mid
   en direct ; mid en direct à plus de 2 % de la clôture. À 2 % pile, accepté.
   Chacun testé, ainsi que le signe.
8. Carnet inexploitable pour un actif : le verdict de production est
   `REJECTED PRICE_SANITY`, le run conclut (`RUN_CONCLU`), le rapport et
   `decisions` portent le motif.
9. Les ombres et le rejeu gardent la clôture comme référence : les verdicts du
   rejeu sur la fixture historique sont identiques avant et après.
10. `make coverage` : `risk.ts` à 100 % lignes et branches.

### Second essai

11. Après un rejet `INVALID_LIMIT_PRICE_POST_ONLY`, la jambe est rejouée une
    fois, au prix du carnet relu, sous un `client_order_id` du domaine
    `ubac.order-id-retry.v1`. Un rejet de tout autre motif n'est pas rejoué.
12. La jambe rejouée repasse par `validate` ; un `PRICE_SANITY` à ce stade
    empêche le placement et se journalise.
13. Un second rejet n'entraîne aucun troisième essai.
14. `ubac.order-id.v1` est inchangé : la valeur figée du test existant ne bouge
    pas. Le nouveau domaine a sa propre valeur figée, et les deux identifiants
    d'une même jambe diffèrent.
15. Rejouer le run du jour ne place ni premier ni second essai (E24 tient pour
    les deux).
16. Le rapport montre le second essai comme une ligne distincte, marquée comme
    telle, et le compte « Rejeté (post-only) » ne compte pas deux fois la même
    jambe si le second essai est placé.

### Annulation des ordres précédents

17. Un ordre ouvert d'un `run_date` antérieur est annulé au run suivant, même
    âgé de moins de 24 h. Testé à 23 h 55.
18. Un ordre ouvert du même `run_date` n'est pas annulé par un second run du
    jour.
19. `MAX_ORDER_AGE_MS` disparaît ; plus aucun test ne fixe la règle des 24 h.
20. Une annulation en échec bloque toujours l'étape 6 (garde existant inchangé).

### Sortie

21. `liquidate.ts` vend au meilleur vendeur du carnet fourni ;
    `MARGE_LIMITE_PCT` n'existe plus ; la sortie reste `VERROUILLE`.

### Documentation et vérification

22. `docs/run-quotidien.md`, `docs/reconciliation.md`, `docs/sortie-propre.md`
    et les deux lignes du §7 de `ubac-rebalance.md` décrivent le nouveau
    comportement et renvoient à cette spec.
23. `make typecheck` et `make test` passent.

## Volume estimé

Environ 900 à 1 100 lignes comptées : route et parseur (~150 avec tests),
couche risque (~200), étape 6 et second essai (~350), `order-id` (~60),
réconciliation (~120), sortie (~80), rapport (~60), documentation (~80). Une
fixture capturée de `best_bid_ask`, exclue du plafond. Le plan dira s'il faut
deux lots : carnet + prix + risque + sortie d'abord, second essai + annulation
ensuite.

**Fichiers communs avec le plan `ubac-convoyeur`** : `src/adapters/coinbase.ts`,
`src/core/order-id.ts`, `src/jobs/daily.ts`, `src/jobs/reconcile.ts`,
`src/report/daily-report.ts`. Le coordinateur sérialise.

## Incertitudes

- **Carnet BTC-USDC.** Coinbase a unifié les carnets USD et USDC ;
  `best_bid_ask` sur `BTC-USDC` doit être vérifié sur une capture réelle avant
  d'écrire le parseur (critère 2).
- **Fréquence du blocage à 2 % de la clôture.** Un mouvement de plus de 2 % entre
  00:00 et 05:00 UTC bloque la production ce jour-là. Fréquence inconnue :
  se lit dans `decisions`.
- **Second essai immédiat.** Le carnet relu une seconde plus tard peut encore
  croiser : le second essai réduit le rejet, il ne le supprime pas.
- **Exécution dans la journée.** Rien ne garantit qu'un ordre au meilleur
  acheteur soit exécuté avant le run suivant (H4).
