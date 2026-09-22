# Lecture Coinbase

Lot **Q3**, découpé en trois. Ce document garde les **constats mesurés** et les
**décisions** qu'ils ont imposées ; le fonctionnement du code est commenté dans
le code, pas répété ici. Chaque morceau apporte sa section avec son code.

| Lot | Ce qu'il apporte | Résultat vérifiable |
|---|---|---|
| **Q3a** | le transport et l'authentification | on s'authentifie et on appelle, ccxt fait ce qu'on croit |
| **Q3b** | les lecteurs : soldes, ordres ouverts, périmètre | on lit le bon portefeuille, aucune écriture n'est atteignable |
| **Q3c** | le marché : bougies journalières | une série complète, ou un refus |
| **S2** (phase 3) | le statut d'un ordre donné et ses exécutions | un ordre dénoué se lit exécuté, annulé, expiré ou rejeté — ou se dit indéterminable |
| **S4** (phase 3) | le port d'exécution et ses deux routes d'écriture | la surface d'écriture est énumérée, et le lecteur ne sait toujours rien écrire |

Chaque section arrive avec le code qu'elle explique : §1 à §3 avec Q3a,
§4 à §7 avec Q3b, §8 avec Q3c, §10 avec S2 ; S4 réécrit le §2.

Références : `docs/specs/ubac-rebalance.md` §3, §7 et §11 ;
`docs/plans/ubac-phase-1.md`, lot Q3 ; décision préalable **D4**, close ;
`docs/cle-coinbase.md` pour la clé. Tout ce qui suit, sauf le §10, a été vérifié
en direct contre la vraie clé, en lecture seule, le **2026-09-11**.

---

## 1. Le transport : six lectures, un seul verbe

`CoinbaseTransport` n'expose que `read(route)` et `close()`. `CoinbaseRoute` est
un type somme **fermé à six requêtes**, toutes en lecture — les deux écritures
de la phase 3 vivent sur un autre transport, §2 :

| Route | Endpoint | Pour |
|---|---|---|
| `key_permissions` | `GET /api/v3/brokerage/key_permissions` | Q3b |
| `accounts` | `GET /api/v3/brokerage/accounts` | Q3b |
| `open_orders` | `GET /api/v3/brokerage/orders/historical/batch?order_status=OPEN` | Q3b |
| `daily_candles` | `GET /api/v3/brokerage/market/products/{id}/candles` | Q3c |
| `order` | `GET /api/v3/brokerage/orders/historical/batch?order_ids={id}` | S2 |
| `fills` | `GET /api/v3/brokerage/orders/historical/fills?order_ids={id}` | S2 |

Les quatre premières sont déclarées ensemble, y compris `daily_candles` que
personne n'appelle encore : une surface close n'a de sens qu'énumérée en entier, et c'est
cette énumération que le test vérifie.

`read` rend la **réponse brute** de l'API. Les structures unifiées de ccxt ne
sont jamais utilisées : elles convertissent les chaînes en `number`, et un
flottant déjà arrondi ne se répare pas. Voir §6.

`CoinbaseReader`, ajouté par Q3b, est la surface que voit le reste du programme —
cinq lectures depuis S2 et une fermeture, et pas d'autre porte :

| Opération | Rend |
|---|---|
| `keyPermissions()` | `canView`, `canTrade`, `portfolioUuid` |
| `balances()` | les soldes du portefeuille dédié, en `Decimal` |
| `openOrders()` | les ordres non dénoués |
| `orderStatus(id)` | le statut réel d'un ordre donné — §10 |
| `orderFills(id)` | ses exécutions — §10 |
| `close()` | — ferme le transport HTTP |

`MarketReader`, ajouté par Q3c, en a une seule : `dailyCandles(asset, window)`,
qui rend une série daily complète en `Decimal`, ou un refus.

---

## 2. Une écriture énumérée, et un lecteur qui n'écrit toujours pas

Jusqu'à la phase 3, ce paragraphe disait « aucune écriture » et l'appuyait sur
trois garanties : la règle de noms d'`eslint.config.js`, le type, et un test qui
recopiait la regexp de la règle. Le lot S4 retire la règle (B4) et la recopie
avec elle ; `docs/phase-1-frontieres.md` §1 dit ce que le dépôt y perd.

Ce qui tient désormais :

1. **le lecteur ne sait rien écrire** : il reçoit un `CoinbaseTransport`, dont
   le seul verbe est `read`. L'écriture passe par `CoinbaseWriteTransport` et
   son verbe `write`, que seul `openCoinbaseExecution` reçoit — `ccxtTransport`
   rend les deux, le point de composition les distribue ;
2. **l'écriture est un type somme fermé à deux routes**, `WRITE_ROUTES` :
   `create_order` (`POST /api/v3/brokerage/orders`, limite `post_only`, le seul
   ordre du §7) et `cancel_orders` (`POST /api/v3/brokerage/orders/batch_cancel`).
   Aucune ne retire ni ne transfère ;
3. **le test énumère** les deux listes de routes, les clés des objets rendus par
   `ccxtTransport()`, `openCoinbase()` et l'exécuteur, et intercepte la couche
   HTTP de ccxt pour vérifier les URL et les méthodes effectivement construites
   (E10). `tsc` refuse qu'un type et sa liste divergent ;
4. **l'exécuteur ne se construit qu'avec `can_trade`** (E7), lu par le lecteur
   sur une clé déjà confrontée au portefeuille attendu (E6).

La garantie qui compte reste **hors du code** : la clé n'a pas la permission de
retrait, et elle est scopée sur le portefeuille dédié. Voir
`docs/cle-coinbase.md`.

---

## 3. Authentification : Ed25519, JWT `EdDSA`, et le claim `uri`

La clé est au format **Ed25519** et non ECDSA/PEM : identifiant UUID, secret
base64 de 88 caractères (graine de 32 octets suivie de la clé publique),
algorithme `EdDSA`. La plupart des exemples publics supposent PEM et `ES256` ;
ils échouent sur cette clé.

**ccxt 4.5.78 gère ce format** — vérifié en direct, les quatre routes répondent
`200`. Il détecte la clé à la longueur du secret (`coinbase.js:5335`) et signe
avec la graine (`coinbase.js:5243-5280`). **Il gère aussi le piège du claim
`uri`** : ce claim ne doit pas porter la chaîne de requête, sous peine de `401`
sur tout appel paramétré — une erreur qui se présente comme un problème
d'identifiants alors que la clé est valide. ccxt tronque l'`uri` au point
d'interrogation (`coinbase.js:5246-5254`).

Aucun code d'authentification n'a donc été écrit : ccxt sert de pilote de
signature et de transport HTTP, rien de plus. Mais les deux comportements sont
**figés par des tests hors ligne** qui appellent `exchange.sign()` et décodent le
JWT produit. C'est la raison d'être de ce lot : si une montée de version les
casse, le test le dit avant que la production ne récolte un `401` qui ressemble à
une clé révoquée.

Les secrets arrivent validés par `src/config/env.ts` et `ccxtTransport` prend
`Pick<Secrets, …>` : personne ne fabrique une clé ailleurs, rien n'est journalisé.

---

## 4. Le constat qui a changé la conception : le scoping n'est pas une barrière

**C'est le point important du lot Q3b.**

Le projet supposait une barrière structurelle : une clé scopée sur le portfolio
`ubac-agent` ne voit pas le portefeuille principal, donc aucun bug de notre côté
ne peut franchir la limite. Mesuré avec la clé, au même instant :

| Appel | Comptes rendus | Soldes visibles |
|---|---|---|
| `GET /api/v3/brokerage/accounts` | **1** (EUR, à zéro) | ceux du portefeuille dédié |
| `GET /v2/accounts` | **164**, dont 100 sur la 1<sup>re</sup> page | ceux de **tout le compte Coinbase** |

Le second a rendu des soldes non nuls sur six devises, dont des actifs qui ne
sont dans aucun portefeuille de l'agent. Le scoping s'applique aux endpoints
**v3 brokerage** ; il ne s'applique pas à l'API v2 en lecture.

**La séparation du portefeuille est donc une réduction de surface, pas une
barrière.** Ce qui tient sans réserve, c'est l'absence de permission d'écriture :
la clé est en lecture seule, rien ne peut sortir ni bouger. Ce qui ne tient pas,
c'est la confidentialité du portefeuille principal. Le constat a été reproduit
par le coordinateur, `docs/cle-coinbase.md` porte la correction ainsi que la
question laissée ouverte : si une clé reçoit un jour `can_trade`, les endpoints
v2 échappent-ils aussi au scoping pour les ordres ? À trancher avant la phase 3,
et à ne pas supposer résolu.

Or le défaut de `fetchBalance()` chez ccxt est `v2PrivateGetAccounts` (4.5.78,
`coinbase.js:440`). Un adapter écrit de la façon la plus naturelle lirait donc le
compte entier en croyant lire le portefeuille dédié, et rien — code, lint,
permissions de la clé — ne le dirait. Trois conséquences :

1. les structures unifiées de ccxt ne sont **jamais** utilisées ; on appelle les
   méthodes implicites, qui rendent la réponse brute ;
2. la route `accounts` est v3, et le test `mappage des routes vers les endpoints`
   échoue si elle repasse en v2 ;
3. `balances()` lit d'abord `key_permissions`, puis **vérifie que chaque compte
   porte le `retail_portfolio_id` de la clé** — constaté égal au
   `portfolio_uuid` que rend `key_permissions`. Un compte rattaché ailleurs
   arrête la lecture ; il n'est pas filtré.

### Ce contrôle n'est pas redondant avec le scoping

C'est la conclusion qu'appelle la lecture rapide — *la clé est déjà scopée, donc
vérifier le portefeuille de chaque compte ne sert à rien* — et c'est elle qui
ferait supprimer le contrôle. Elle est fausse pour deux raisons distinctes : le
scoping ne couvre pas tous les endpoints, c'est la mesure ci-dessus ; et les deux
ne portent pas sur le même objet. Le scoping est une propriété de **la clé**,
évaluée chez Coinbase, dont la portée dépend de l'endpoint appelé. Le contrôle de
rattachement est une propriété de **la réponse**, évaluée ici, et il vaut pour
n'importe quel endpoint qu'un successeur brancherait sur ce module. C'est la
seule des deux que le dépôt possède et sait tester.

La raison est écrite dans `balanceFrom`, à côté du contrôle, et pas seulement
ici : c'est là que la question se posera.

---

## 5. Ce qui est refusé

| Cas | Pourquoi ce n'est pas filtré en silence |
|---|---|
| Une paire non cotée en USDC | Une cession vers EUR est un fait générateur d'imposition (spec §11). `src/core/risk.ts` contrôle ce que l'agent **veut faire** ; l'adapter, ce que l'**exchange raconte**. Un ordre `*-EUR` ouvert dans ce portefeuille est une anomalie, pas une donnée à ignorer. |
| Tout champ de `key_permissions` hors de `can_view`, `can_trade`, `portfolio_uuid` et `portfolio_type` qui n'est pas le booléen `false` | Sur une permission, la lecture la plus défavorable : seul `false` vaut refus, et une chaîne — `"false"` comprise —, un nombre, `null` ou un objet se lit **accordé**. Le contrôle est **générique** et ne nomme pas la permission de sortie : `eslint.config.js` en interdit le mot dans `src/adapters/`, y compris en lecture. Il attrape en prime une permission que Coinbase ajouterait demain. Le test, lui, la nomme — la règle ne s'applique pas à `test/`. |
| `can_view` autre que le booléen `true`, `can_trade` ni `true` ni `false` | Ce que la clé peut faire ne se devine pas. `can_trade` rendu `"true"` ne doit pas se lire « refusé ». |
| Un ordre sans prix limite | La spec §7 n'admet que des ordres limit post-only. La configuration est cherchée par ses **champs** (`base_size` + `limit_price`) et non par sa clé, donc `limit_limit_gtc`, `limit_limit_gtd` et toute variante future passent sans changement. |
| Une grandeur qui n'est pas une décimale littérale | Voir §6. |
| Une pagination dont le curseur ne progresse pas | Un curseur rendu inchangé ferait tourner le job indéfiniment, sans erreur et sans journal. |

**Mais pas une *devise* EUR.** Le portefeuille réel contient un compte EUR, créé
par Coinbase avec le portfolio, à zéro. Refuser la devise ferait échouer la
lecture dès le premier run : la contrainte du §11 porte sur les paires cotées,
pas sur les soldes constatés.

---

## 6. Aucun flottant, et le piège du « déjà arrondi »

L'API publie des **chaînes** : `"76440"`, `"0.00000001"`, `"0"`. ccxt les
convertit en `number` dans ses structures unifiées, sans conserver la réponse
d'origine. Or un flottant déjà arrondi ne se répare pas : le convertir en
`Decimal` **fige l'erreur au lieu de l'éviter**. D'où la règle, tenue de bout en
bout : on lit la réponse brute, et `decimalFromApi()` refuse explicitement un
`typeof value === 'number'` avec un message qui dit pourquoi — comme l'exposant,
`NaN`, `Infinity` et l'hexadécimal, contre lesquels `gt` et `lt` répondent tous
les deux `false`, de sorte qu'aucun seuil ne mord.

Même frontière et même motif que `src/adapters/schema.ts` côté base et que
`src/config/env.ts` côté configuration. Le motif est **recopié** dans les trois
modules plutôt qu'importé, comme `schema.ts` l'a déjà fait et pour la même
raison : chacun appartient à un lot différent.

---

## 7. Les tests, et la fixture réelle

Aucun test ne touche le réseau. Deux régimes cohabitent, signalés fichier par
fichier.

**Réponses réelles**, capturées le 2026-09-11 contre la vraie clé en lecture
seule, dans `test/adapters/fixtures/` : `coinbase-key-permissions.json`
(`can_view` vrai, `can_trade` faux), `coinbase-accounts.json` (le portefeuille
réel : un compte EUR à zéro) et `coinbase-orders-open-empty.json` (l'absence
d'ordre ouvert, telle que l'API l'écrit). Elles portent les formes que personne
n'invente : `available_balance` en `{value, currency}` et non en nombre,
`"value": "0"` et non `"0.00"`, `deleted_at: null`, `sequence: "0"`,
`proof_token_required`.

**Tous les identifiants de compte sont expurgés** : chaque UUID est remplacé par
un UUID de test (`00000000-0000-4000-8000-0000000000xx`). Aucun solde réel du
compte principal n'est versionné — le portefeuille dédié est vide, et la lecture
v2 qui aurait montré les vrais soldes n'est écrite nulle part.

**Réponses fabriquées**, pour ce que le portefeuille dédié ne contient pas : la
clé est en lecture seule et aucun ordre n'y a jamais été passé, donc **aucune
capture réelle d'ordre ouvert n'existe**. Ces réponses sont calquées sur
l'échantillon que ccxt conserve dans son propre source et signalées comme
fabriquées à chaque emploi. C'est la seule partie du lot qui repose sur une
source secondaire.

**Un ordre exécuté, fabriqué et déclaré comme tel (décision T2, lot S2).**
`coinbase-order-filled.json` et `coinbase-order-fills.json` **ne sont pas des
captures** : le portefeuille dédié n'a jamais passé d'ordre, et n'en passera pas
avant S7. Leur forme est calquée sur les échantillons de `coinbase.js` (ccxt
4.5.78), leurs grandeurs choisies pour qu'une somme en `number` se trompe —
0,1 + 0,2 en taille, 1,001276 + 2,002552 en frais. Chacune le dit dans son
champ `_fabrique` ; le test les charge par `fabriquee()`, qui exige ce champ, et
`reelle()` refuse de charger un fichier qui le porte. **Elles seront remplacées
par une capture après le premier ordre réel** — le champ retiré, et le
chargement basculé sur `reelle()`. Une fixture fabriquée qu'on croit capturée
est pire que les deux.

**Ce que les tests garantissent vraiment.** Quatre mutations ont été appliquées
au code et la suite a échoué à chaque fois : désarmer le contrôle de rattachement
au portefeuille, faire accepter un `number` à `decimalFromApi`, accepter toute
contrepartie, et repasser la lecture des soldes en v2. Un test qui ne meurt pas
quand le code ment ne garantit rien.

---

## 8. Les bougies : `normalise.ts` reste le seul contrôle

`market.ts` ne vérifie **rien** de la série lui-même. Le trou, l'horodatage qui
ne tombe pas sur 00:00 UTC, le prix nul ou négatif, la bougie en double : tout
cela est traité par `src/fixture/normalise.ts`, écrit en phase 0. Y ajouter une
vérification ici donnerait deux définitions de « série acceptable », qui
divergeraient à la première correction.

Le chemin est donc court et sans intelligence : construire le calendrier attendu
(`expectedCalendar`), demander la fenêtre, passer les bougies **brutes** à
`normaliseSeries`, convertir les chaînes qu'il conserve. Les prix traversent en
chaînes de bout en bout — c'est ce qui fait qu'aucun flottant n'apparaît nulle
part, y compris à l'intérieur du normaliseur, qui refuse déjà un prix publié en
nombre JSON. Ce que l'adapter fait, lui :

- **construire le produit** `{asset}-USDC` et le passer au contrôle de paire du
  §5 ; `USDC` n'est pas une ligne négociable et est refusé ;
- **refuser avant l'appel** une fenêtre dont les bornes ne forment pas un
  calendrier — aucune requête n'est émise ;
- **refuser une fenêtre de plus de 350 jours**, plafond de l'API par appel.
  Au-delà elle tronque, et le normaliseur refuserait la série pour jours
  manquants : correct, mais racontant la mauvaise cause. Les 200 jours de la
  spec §8 tiennent largement dans un appel.

L'endpoint utilisé est le **public** (`/brokerage/market/products/…`) : une
bougie daily n'appartient à personne, et s'en passer de signature évite de donner
à la lecture de marché une raison d'avoir la clé.

`end` est **inclusif** côté Coinbase : la bougie qui ouvre à `end` est rendue. On
vise donc l'ouverture du dernier jour et non sa fin, sans quoi l'API rendrait une
bougie de plus, hors calendrier, que `normaliseSeries` jetterait sans rien dire.

### Deux propriétés mesurées de l'API

**Les bougies reviennent du plus récent au plus ancien.** `normaliseSeries` les
réordonne sur le calendrier, donc l'ordre d'arrivée n'a pas d'importance — mais
s'y fier en aurait eu.

**La bougie du jour en cours est partielle et bouge.** Deux appels à quelques
minutes d'intervalle ont rendu `77180.42` puis `77215.57` en clôture du même
jour. Une fenêtre qui inclut aujourd'hui donne donc une clôture qui n'en est pas
une. L'adapter ne peut pas trancher à la place de l'appelant — il n'a pas
d'horloge, comme le reste du dépôt — donc **c'est au job de s'arrêter au dernier
jour clos**. À reprendre dans le lot Q4.

### Les tests

`test/adapters/market.test.ts` ne teste pas le normaliseur :
`test/fixture/normalise.test.ts` le fait depuis la phase 0. Il teste que
l'adapter lui passe bien la main, et que le refus arrive **intact** jusqu'à
l'appelant — trou, horodatage non aligné, prix nul, prix publié en nombre JSON,
chaque refus vérifié par son code (`DAY_MISSING`, `TIMESTAMP_NOT_UTC_MIDNIGHT`,
`PRICE_NOT_POSITIVE`, `CANDLE_MALFORMED`) et non par son texte.

La série de référence est **réelle** : `coinbase-candles-btc-usdc.json`, huit
bougies BTC-USDC capturées le 2026-09-11. Elle porte les deux formes que personne
n'invente — un horodatage `start` publié en **chaîne** de secondes, et des prix
entiers écrits sans décimale (`"76440"`) à côté de prix à deux décimales. Aucune
donnée de compte : une bougie est publique.

---

## 9. Ce que ces lots n'écrivent pas

- **Aucun ordre, dans aucune direction.** Phase 3.
- **Aucune réconciliation.** Comparer soldes réels et état interne est le §7 de
  la spec, lot Q4 : ces lots fournissent la lecture, pas la décision.
- **Aucun prix mid ni carnet.** Le prix limite à mid ± 0,1 % est de la phase 3.
- **Aucune écriture en base.** `db.ts` est le lot Q2.
- **Aucune horloge.** Les deux modules reçoivent les fenêtres qu'on leur demande
  et ne datent rien eux-mêmes — d'où le renvoi de la bougie partielle au job.

---

## 10. Le statut d'un ordre et ses exécutions (S2)

Le prérequis que `docs/reconciliation.md` §4 posait à la phase 3 : distinguer
les issues d'un ordre dénoué demande son statut réel, ou ses exécutions, pas la
liste des ordres ouverts. **S2 porte la lecture, S8 porte le branchement dans
`src/jobs/reconcile.ts`, et E37 n'est clos qu'après les deux** : d'ici S8, la
réconciliation rend encore `INDETERMINABLE` pour tout ordre dénoué.

**La liste filtrée, pas la lecture par identifiant.** Sur un identifiant
inconnu, `GET …/orders/historical/{order_id}` répond 404, et ccxt 4.5.78 en fait
une `ExchangeError` générique : sa correspondance `OrderNotFound` cherche le
message dans le champ `error`, qui vaut `unknown` dans l'échantillon qu'il garde.
Un ordre inconnu y serait indiscernable d'une panne. La liste filtrée par
`order_ids` rend `orders: []` — une **réponse**, et la forme exacte de la liste
vide capturée le 2026-09-11. Un test fige le comportement de ccxt. En
contrepartie, la réponse doit porter **exactement** l'ordre demandé : un autre
identifiant prouve que le filtre n'a pas été honoré, et la lecture s'arrête au
lieu de rendre le statut d'un autre ordre. Même contrôle sur chaque exécution.

| Statut Coinbase | Lu |
|---|---|
| `PENDING`, `QUEUED`, `OPEN`, `CANCEL_QUEUED` | `OPEN` — l'ordre vit encore |
| `FILLED`, `CANCELLED`, `EXPIRED`, `FAILED` | le même nom ; `FAILED` est l'ordre rejeté |
| tout autre, `UNKNOWN_ORDER_STATUS` compris | `INDETERMINABLE`, statut et quantité exécutée dans le motif |

Les quatre issues restent **distinctes** : ccxt replie `EXPIRED` et `FAILED` sur
`canceled` dans ses structures unifiées. **Un statut inconnu ne se replie jamais
sur `CANCELLED`** — ce serait classer en annulé un ordre peut-être exécuté ; la
sonde est un ordre exécuté à 100 % sous `UNKNOWN_ORDER_STATUS`. La table est une
`Map` : en objet littéral, un statut `toString` trouverait une valeur dans le
prototype. **La quantité exécutée accompagne toute issue**, `CANCELLED`
comprise : un ordre partiellement exécuté puis annulé la garde.

**Les exécutions.** La réponse n'a pas de `has_next` : la suite existe tant que
le curseur et la page ne sont pas vides, sans quoi tout ce qui dépasse la
première page serait tronqué en silence. `trade_type` autre que `FILL` — une
correction ne s'additionne pas sans règle — et `size_in_quote` autre que le
booléen `false` — une taille dont l'unité se devine fausse le solde — arrêtent la
lecture. `trade_time` est publié à la nanoseconde ; `Date` le tronque à la
milliseconde.

**Les frais** entrent par `decimalFromApi` — `total_fees` pour l'ordre,
`commission` par exécution —, jamais par une structure unifiée de ccxt, et en
USDC, la paire étant vérifiée. `test/adapters/frontiere-decimal.test.ts` étend
son contrôle de noms à `coinbase.ts`.

**Ce qui n'est pas vérifié contre l'API**, faute d'ordre réel (T2) : que
`order_ids` filtre bien les deux routes, que `fills` n'ait pas de `has_next`,
que `size_in_quote` vaille `false` sur un ordre limit en taille de base. Chaque
écart se lit **bruyamment** — la lecture s'arrête — et la première capture le
tranchera. Le lecteur ne recoupe pas non plus la somme des exécutions avec
`filled_size` et `total_fees` : les deux peuvent se suivre avec retard, et c'est
au branchement de S8 d'en décider.
