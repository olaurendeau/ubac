# Créer la clé Coinbase de l'agent

Procédure à exécuter par l'opérateur. Elle débloque le lot Q3 de la phase 1
(adapters de lecture). Décision D4 du plan `docs/plans/ubac-phase-1.md`.

Rien de cette procédure ne se fait depuis le dépôt ni depuis un agent : c'est
une manipulation manuelle, et la clé produite ne rentre jamais dans Git.

## Le principe, avant les clics

La protection ne repose pas sur le code. Elle repose sur le fait que **la clé ne
peut structurellement pas atteindre l'argent principal ni le faire sortir**.
Deux barrières, dans cet ordre d'importance :

1. **Un portfolio dédié.** Une clé Coinbase est scopée à un portfolio :
   « Each API key is scoped to specific portfolio and, **unless otherwise
   noted**, can only view and create data that belongs to its own portfolio. »
   Les mots « unless otherwise noted » ne sont pas décoratifs : voir
   l'avertissement ci-dessous.
2. **Aucune permission de sortie.** La phase 1 observe et n'exécute rien : la
   clé n'a besoin que de lire. C'est la barrière qui tient sans réserve.

> ### Le scoping ne couvre pas les endpoints v2
>
> **Correction du 2026-09-11.** Une version antérieure de cette note affirmait
> qu'aucun bug ni aucune erreur de configuration ne pouvait franchir la limite
> du portfolio, « parce qu'elle n'est pas dans notre code ». **C'est faux**, et
> la mesure le montre sans ambiguïté. Avec la clé scopée sur `ubac-agent` :
>
> ```
> GET /api/v3/brokerage/accounts  ->  200,   1 compte
> GET /v2/accounts                ->  200, 100 comptes sur la première page
>                                     (EUR, ATOM, XTZ, SOL, ADA, APE…)
> ```
>
> Les devises rendues par `/v2/accounts` ne sont pas celles du portfolio dédié :
> c'est le compte Coinbase entier. Le scoping au portfolio s'applique aux
> endpoints **v3 brokerage**, pas à l'API v2.
>
> Ce qui reste vrai : la clé est en **lecture seule**, donc rien ne peut sortir
> ni bouger. La confidentialité du portefeuille principal, elle, n'est pas
> assurée par le scoping.
>
> Ce qui change dans la conception : la séparation du portfolio est une
> **réduction de surface**, pas une barrière infranchissable. Le code doit
> lire en v3 et vérifier le rattachement de chaque compte au portfolio attendu,
> plutôt que de s'en remettre au scoping. C'est ce que fait l'adapter.
>
> **À trancher avant la phase 3 :** si une clé reçoit un jour `can_trade`, les
> endpoints v2 échappent-ils aussi au scoping pour les ordres ? La question
> n'est pas tranchée ici et elle doit l'être avant toute activation
> d'exécution. Ne pas supposer que non.

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

### Résultat du contrôle, 2026-09-11

Clé vérifiée, décision D4 close.

```
HTTP 200
can_view       : true
can_trade      : false
can_transfer   : false
portfolio_uuid : 04f1112e-…
portfolio_type : CONSUMER
```

Le portfolio `04f1112e-…` porte le nom `ubac-agent`. Un second portfolio
`Default` de type `DEFAULT` existe sur le compte et la clé n'y a **pas** accès :
la séparation visée est effective.

`portfolio_type: CONSUMER` n'est pas une anomalie. Il désigne un portfolio créé
depuis le compte particulier, par opposition au `DEFAULT` d'Advanced Trade. Ce
qui compte est l'UUID, pas le type.

## Deux pièges d'implémentation, constatés à la vérification

Ils valent pour tout code qui parlera à cette API, et coûtent des heures à qui
les découvre seul.

**1. Le claim `uri` du JWT ne doit pas contenir la chaîne de requête.**
Mesuré sur le même appel, au même instant :

```
uri = "GET api.coinbase.com/api/v3/brokerage/products/BTC-USDC/candles?start=…"   -> 401
uri = "GET api.coinbase.com/api/v3/brokerage/products/BTC-USDC/candles"           -> 200
```

L'erreur se présente comme un `401 Unauthorized`, donc comme un problème
d'identifiants, alors que la clé et la signature sont parfaitement valides. Tout
appel paramétré échoue, tout appel sans paramètre passe : de quoi conclure à
tort que la clé a des permissions partielles.

**2. La clé est au format Ed25519, pas ECDSA/PEM.**
L'identifiant est un UUID de 36 caractères, et non la forme
`organizations/…/apiKeys/…` que documentent beaucoup d'exemples. Le secret est
un base64 de 88 caractères, soit 64 octets — graine de 32 octets suivie de la
clé publique — et non un bloc PEM. L'algorithme du JWT est `EdDSA`, pas `ES256`.
Une bibliothèque ou un exemple qui suppose le format PEM échouera sur cette clé.

## La clé de phase 3 : le portefeuille attendu, vérifié à chaque run

Critères E6 à E8 de [la spec de phase 3](specs/ubac-phase-3.md), lot S1.

**Le contrôle de la phase 1 est auto-référentiel.** L'adapter vérifie que chaque
compte lu est rattaché au `portfolio_uuid` **que la clé déclare**. Il prouve que
la réponse est cohérente avec la clé, pas que la clé est scopée sur le bon
portefeuille : une clé créée par erreur sur *Primary* — sélectionné par défaut
à l'étape 2 — le passe sans rien faire rougir. En phase 1, la conséquence est
une lecture du portefeuille principal ; en phase 3, un rééquilibrage exécuté
dessus.

D'où **`COINBASE_PORTFOLIO_UUID`**, posée par l'opérateur chez Scaleway
([deploiement.md](deploiement.md) section 1). Le lecteur Coinbase la reçoit à sa
construction et compare **exactement** le `portfolio_uuid` de
`key_permissions` avec elle ; **chaque lecture** commence par ce contrôle,
quel que soit l'ordre des appels. Une clé scopée ailleurs arrête le run à
l'étape 1, avant la réconciliation, avec l'alerte `JOB_FAILED`. Le contrôle de
rattachement **reste** : l'un prouve l'identité du portefeuille, l'autre la
cohérence de la réponse, et aucun des deux ne remplace l'autre.

Chaque run journalise la clé **telle que la réponse la porte**, avant le
verdict, pour qu'une clé refusée dise ce qu'elle est :

```
cle coinbase — portefeuille=<uuid> attendu=oui can_view=true can_trade=true can_transfer=false
```

Aucun secret n'y figure : le lecteur n'a jamais la clé en main, seul le
transport la tient, et un test le vérifie par le vrai transport, jeton signé
compris.

### Procédure, au moment d'E4

1. Créer une **nouvelle** clé, `ubac-phase-3-trade` par exemple, scopée sur
   `ubac-agent` : lecture et trade, **pas** transfer. Pas une permission ajoutée
   à la clé de phase 1.
2. Vérifier ce qui a été accordé, comme à l'étape 4 : `can_view` et `can_trade`
   vrais, `can_transfer` faux, `portfolio_uuid` celui de `ubac-agent`.
3. Poser `COINBASE_PORTFOLIO_UUID` chez Scaleway **avant** de déployer l'image
   qui l'exige, puis remplacer `COINBASE_API_KEY` et `COINBASE_API_SECRET`.
4. Reporter le résultat dans Orca — l'UUID y va, **jamais dans ce dépôt** — et
   révoquer la clé de phase 1.
5. **Mesurer**, sur la nouvelle clé, si les endpoints v2 échappent aussi au
   scoping pour les ordres (encadré plus haut). La réponse se mesure ; elle ne
   se déduit pas.

### Résultat du contrôle de la clé de phase 3

**Pas encore fait** : la clé n'existe pas (E4). Le lot S1 est vérifié contre des
fixtures — la réponse réelle de la clé de phase 1, et une réponse **fabriquée**
avec `can_trade` vrai, déclarée comme telle dans le test. Le bout en bout contre
la nouvelle clé reste à faire, et à reporter ici comme le contrôle du
2026-09-11.

## Ce qui reste à décider plus tard

- **Approvisionnement du portefeuille.** Rien n'est exigé en phase 1. Le montant
  et le moment sont une décision de l'opérateur avant la phase 3.
- **Passage en lecture + trade.** La phase 3 active l'exécution et demandera une
  clé avec `can_trade`. Ce sera une nouvelle clé, créée à ce moment-là, pas une
  permission ajoutée discrètement à celle-ci. Une clé qui gagne des droits en
  cours de route est une clé dont plus personne ne connaît la portée. Procédure
  ci-dessus.
- **Rotation.** À prévoir avec la phase 2, quand les secrets passeront en
  variables secrètes Scaleway.

## Références

- [Advanced Trade Portfolios](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/portfolios) — scoping d'une clé à un portefeuille.
- [Get API Key Permissions](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/data-api/get-api-key-permissions) — `can_view`, `can_trade`, `can_transfer`, `portfolio_uuid`.
- [Welcome to Advanced Trade API](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/overview) — vue d'ensemble et authentification.
- [Multiple portfolios](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/multiple-portfolios) — création sur le web uniquement, limite de 25, approvisionnement par virement interne.
