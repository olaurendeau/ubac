# Créer la clé Coinbase de l'agent

Procédure à exécuter par l'opérateur. Elle débloque le lot Q3 de la phase 1
(adapters de lecture). Décision D4 du plan `docs/plans/ubac-phase-1.md`.

Rien de cette procédure ne se fait depuis le dépôt ni depuis un agent : c'est
une manipulation manuelle, et la clé produite ne rentre jamais dans Git.

## Le principe, avant les clics

La protection ne repose pas sur le code. Elle repose sur le fait que **la clé ne
peut structurellement pas atteindre l'argent principal ni le faire sortir**.
Deux barrières, dans cet ordre d'importance :

1. **Un portefeuille dédié.** Une clé Coinbase est scopée à un portefeuille :
   « Each API key is scoped to specific portfolio and, unless otherwise noted,
   can only view and create data that belongs to its own portfolio. » Un
   portefeuille séparé rend le portefeuille principal invisible pour l'agent.
   Aucun bug, aucune régression et aucune erreur de configuration ne peut
   franchir cette limite, parce qu'elle n'est pas dans notre code.
2. **Aucune permission de sortie.** La phase 1 observe et n'exécute rien : la
   clé n'a besoin que de lire.

## Les permissions, et le piège

Une clé CDP porte trois permissions : `can_view`, `can_trade`, `can_transfer`.

| Permission | Phase 1 | Phase 3 |
|---|---|---|
| `can_view` | **oui** | oui |
| `can_trade` | **non** | oui |
| `can_transfer` | **non, jamais** | **non, jamais** |

**Attention sur `can_transfer`.** Des guides tiers largement repris affirment
que cette permission ne permet que des mouvements entre vos propres
portefeuilles et n'autorise pas de retrait vers une adresse externe. La
référence officielle CDP la décrit autrement : *deposit/withdrawal permissions*.

Les deux affirmations ne peuvent pas être vraies en même temps, et l'écart porte
précisément sur la capacité à sortir des fonds. En cas de doute sur une
permission qui touche au retrait, on prend la lecture la plus défavorable :
**`can_transfer` reste désactivée, en phase 1 comme après.** La spec l'exige
déjà — « Permissions : lecture + trade. Jamais de permission de retrait. » — et
cette ambiguïté est une raison de plus de ne pas y toucher.

## Procédure

### 0. Ne pas se tromper de produit

Le vocabulaire de Coinbase prête à confusion et l'erreur coûte du temps.

| | |
|---|---|
| Ce qu'il faut | un **portfolio** Coinbase Advanced, sous-division du compte d'échange |
| Ce qu'il ne faut pas | la **Base app**, ex-Coinbase Wallet : portefeuille auto-dépositaire on-chain |

Une clé CDP se scope à un *portfolio* Advanced Trade. Elle ne peut pas se
rattacher à la Base app, qui relève d'un tout autre produit. Le mot
« portefeuille » employé ailleurs dans cette note désigne toujours un portfolio
Advanced Trade.

### 1. Créer le portfolio dédié

**Sur le web uniquement.** La création de portfolio n'est pas disponible dans
l'application mobile — c'est la seule étape de cette procédure qui ne peut pas
se faire depuis le téléphone.

```
coinbase.com  →  Advanced  →  page Portfolio  →  Create portfolio
```

Lui donner un nom explicite, `ubac-agent` par exemple, pour qu'aucune
manipulation ultérieure ne se trompe de cible. Le compte en autorise jusqu'à 25.

Ne rien y transférer pour l'instant. La phase 1 lit un portfolio, même vide ou
faiblement doté ; l'approvisionnement est une décision distincte, à prendre
avant la phase 3.

À savoir pour ce moment-là : **un portfolio ne s'approvisionne pas
directement**. Les fonds viennent d'un virement depuis le Primary ou depuis un
autre portfolio, instantané et gratuit.

### 2. Créer la clé API scopée dessus

Toujours sur le web, dans le **CDP Portal**, section API Keys, créer une clé :

- lui donner un nom explicite, `ubac-phase-1-readonly` par exemple ;
- dans les réglages avancés, section *Coinbase App & Advanced Trade*,
  **sélectionner le portefeuille `ubac-agent`**. C'est l'étape critique : le
  portefeuille *Primary* est sélectionné par défaut, et le laisser tel quel
  donnerait à l'agent la vue sur le portefeuille principal ;
- **ne cocher que la lecture.** Pas de trade, pas de transfer.

Le chemin exact dans l'interface change régulièrement ; ce qui compte est le
résultat, pas le chemin. Après création, vérifier ce qui a réellement été
accordé plutôt que ce qui a été coché — voir l'étape 4.

### 3. Récupérer la clé

Coinbase propose un téléchargement JSON à la création. **Le secret n'est affiché
qu'à ce moment-là** : une clé perdue se remplace, elle ne se relit pas.

Placer les valeurs dans le fichier `.env` local, jamais dans le dépôt. Les noms
attendus sont dans [`.env.example`](../.env.example) :

```
COINBASE_API_KEY=
COINBASE_API_SECRET=
```

Le fichier `.env` est ignoré par Git — vérifiable dans `.gitignore`. Ne pas
coller le contenu de la clé dans une conversation avec un agent, y compris moi :
un secret qui transite dans un historique de session est un secret à révoquer.

### 4. Vérifier ce qui a réellement été accordé

Ne pas se fier aux cases cochées. L'API expose les permissions effectives de la
clé, avec le portefeuille auquel elle est rattachée :

```
GET /api/v3/brokerage/key_permissions
```

La réponse doit montrer `can_view` à vrai, `can_trade` et `can_transfer` à faux,
et un `portfolio_uuid` qui est celui du portefeuille dédié — **pas** celui du
portefeuille principal.

C'est le seul contrôle qui compte. Une case décochée dans une interface n'est
pas une preuve ; la permission effective en est une.

Reporter le résultat de ce contrôle dans Orca : c'est lui qui clôt la décision
D4 et débloque Q3.

## Ce qui reste à décider plus tard

- **Approvisionnement du portefeuille.** Rien n'est exigé en phase 1. Le montant
  et le moment sont une décision de l'opérateur avant la phase 3.
- **Passage en lecture + trade.** La phase 3 active l'exécution et demandera une
  clé avec `can_trade`. Ce sera une nouvelle clé, créée à ce moment-là, pas une
  permission ajoutée discrètement à celle-ci. Une clé qui gagne des droits en
  cours de route est une clé dont plus personne ne connaît la portée.
- **Rotation.** À prévoir avec la phase 2, quand les secrets passeront en
  variables secrètes Scaleway.

## Références

- [Advanced Trade Portfolios](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/portfolios) — scoping d'une clé à un portefeuille.
- [Get API Key Permissions](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/data-api/get-api-key-permissions) — `can_view`, `can_trade`, `can_transfer`, `portfolio_uuid`.
- [Welcome to Advanced Trade API](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/overview) — vue d'ensemble et authentification.
- [Multiple portfolios](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/multiple-portfolios) — création sur le web uniquement, limite de 25, approvisionnement par virement interne.
