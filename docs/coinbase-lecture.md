# Lecture Coinbase

Lot **Q3**, découpé en trois. Ce document garde les **constats mesurés** et les
**décisions** qu'ils ont imposées ; le fonctionnement du code est commenté dans
le code, pas répété ici. Chaque morceau apporte sa section avec son code.

| Lot | Ce qu'il apporte | Résultat vérifiable |
|---|---|---|
| **Q3a** | le transport et l'authentification | on s'authentifie et on appelle, ccxt fait ce qu'on croit |
| **Q3b** | les lecteurs : soldes, ordres ouverts, périmètre | on lit le bon portefeuille, aucune écriture n'est atteignable |
| **Q3c** | le marché : bougies journalières | une série complète, ou un refus |

Références : `docs/specs/ubac-rebalance.md` §3, §7 et §11 ;
`docs/plans/ubac-phase-1.md`, lot Q3 ; décision préalable **D4**, close ;
`docs/cle-coinbase.md` pour la clé. Tout ce qui suit a été vérifié en direct
contre la vraie clé, en lecture seule, le **2026-09-11**.

---

## 1. Le transport : quatre requêtes, un seul verbe

`CoinbaseTransport` n'expose que `read(route)` et `close()`. `CoinbaseRoute` est
un type somme **fermé à quatre requêtes**, toutes en lecture :

| Route | Endpoint | Pour |
|---|---|---|
| `key_permissions` | `GET /api/v3/brokerage/key_permissions` | Q3b |
| `accounts` | `GET /api/v3/brokerage/accounts` | Q3b |
| `open_orders` | `GET /api/v3/brokerage/orders/historical/batch?order_status=OPEN` | Q3b |
| `daily_candles` | `GET /api/v3/brokerage/market/products/{id}/candles` | Q3c |

Les quatre sont déclarées ici, y compris celles que personne n'appelle encore :
une surface close n'a de sens qu'énumérée en entier, et c'est cette énumération
que le test vérifie.

`read` rend la **réponse brute** de l'API. Les structures unifiées de ccxt ne
sont jamais utilisées : elles convertissent les chaînes en `number`, et un
flottant déjà arrondi ne se répare pas. La conversion en `Decimal` se fait au
lot suivant, sur la chaîne d'origine.

---

## 2. Aucune écriture, et pourquoi ce n'est pas qu'une promesse

Trois garanties indépendantes, de la plus faible à la plus forte :

1. **le lint** (`eslint.config.js`, lot Q1) interdit dans `src/adapters/` et
   `src/jobs/` tout nom qui dénote un placement, une annulation ou un retrait, et
   `noInlineConfig` empêche de le désarmer depuis le fichier surveillé. Il garde
   le **source** ;
2. **le type** : un seul verbe, `read`, sur le type somme ci-dessus. Aucune
   écriture n'est **exprimable**, pas même en composant ce que le module
   exporte — pas de client brut, pas de route générique, pas de méthode `post`.
   Ajouter un chemin est une modification visible de ce type ;
3. **le test** vérifie les deux à l'exécution : il recopie la regexp de noms
   d'`eslint.config.js` et l'applique aux exports réels du module et aux clés de
   l'objet rendu par `ccxtTransport()`, puis intercepte la couche HTTP de ccxt
   pour contrôler les URL effectivement construites.

La garantie qui compte reste **hors du code** : la clé n'a pas la permission de
trader. Voir `docs/cle-coinbase.md`.

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

### Pourquoi la route `accounts` est en v3

Le défaut de `fetchBalance()` chez ccxt est `v2PrivateGetAccounts` (4.5.78,
`coinbase.js:440`), et le scoping de la clé au portfolio **ne couvre pas l'API
v2** : la même clé y rend le compte principal. Le test `lit les soldes en v3,
jamais en v2` garde ce choix. Le constat complet, et le contrôle de périmètre
qui en découle, appartiennent au lot Q3b — ils voyagent avec le code qu'ils
justifient.

---

## 4. Ce que ce lot n'écrit pas

- **Aucune relecture de réponse.** `read` rend ce que l'API a envoyé ; aucune
  conversion, aucune validation. C'est le lot Q3b.
- **Aucun ordre, dans aucune direction.** Phase 3.
- **Aucune horloge.** Le transport reçoit les fenêtres qu'on lui demande.
