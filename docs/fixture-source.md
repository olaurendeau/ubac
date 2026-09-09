# Source de la fixture de bougies

Repond a la zone d'incertitude « la fixture de bougies n'est pas auditee » de
`docs/specs/ubac-phase-0.md`. Trois choses n'y etaient pas specifiees : la
source, le fuseau de cloture, le traitement des trous. Elles sont figees ici.

Ce fichier est la reference ; `scripts/build-fixture.ts` l'applique.

## Source

**Coinbase Advanced Trade**, endpoint public de donnees de marche :

```
GET https://api.coinbase.com/api/v3/brokerage/market/products/{product_id}/candles
    ?granularity=ONE_DAY&start=<epoch_s>&end=<epoch_s>
```

Produits : `BTC-USDC` et `ETH-USDC`. Plage : du **2024-01-01 au 2026-08-31**
inclus, soit **974 jours** par produit.

Pourquoi celle-la plutot qu'un agregateur (CoinGecko, Kraken, Binance) :

- C'est le lieu d'execution reel du systeme. Rejouer sur les prix d'une autre
  place mesurerait la strategie sur des prix qu'Ubac n'aurait jamais obtenus.
- Les paires sont cotees en USDC, pas en USD. La spec interdit le cash en EUR et
  raisonne en USDC ; une serie `BTC-USD` introduirait un ecart de parite muet.
- L'API rend les prix en **chaines decimales**, pas en flottants JSON. La regle
  « aucun `number` flottant sur un prix » tient jusqu'au CSV, sans conversion
  intermediaire.

Cette API est publique et sans authentification : aucun secret n'entre dans le
depot pour reconstruire la fixture.

## Fuseau de cloture

**UTC.** Une bougie `ONE_DAY` ouvre a `00:00:00Z` et cloture a `23:59:59Z`. Le
champ `date` du CSV est le jour d'**ouverture** du bucket.

C'est le point le plus dangereux de la fixture : une source qui cloture en heure
locale (New York, Paris) decale toute la serie d'un fuseau. Le rejeu resterait
vert, les chiffres seraient faux. Le script ne se fie donc pas au contrat de
l'API : il verifie que chaque horodatage recu est un multiple exact de 86 400 s
et abandonne sinon.

Aucune conversion, aucun decalage, aucun `Date` sans fuseau explicite nulle part
dans la chaine.

## Regle de trou

**Aucun trou n'est tolere. Un jour manquant fait echouer le script, qui n'ecrit
aucun fichier.**

Il n'y a ni report de la veille, ni interpolation, ni saut de ligne. Les trois
inventeraient un prix, et un prix invente traverse le rejeu sans qu'aucun test
ne le distingue d'un prix reel.

Corollaire operationnel : si la source presente un trou, la reponse n'est pas de
le combler, c'est de changer de source ou de plage — et de modifier ce fichier
dans la meme PR. Le trou est une decision, pas un detail d'implementation.

Sont egalement des echecs, pour la meme raison :

| Cas | Traitement |
|---|---|
| Jour absent de la reponse | echec, rien n'est ecrit |
| Horodatage non aligne sur 00:00 UTC | echec, rien n'est ecrit |
| Prix nul, negatif, non fini ou illisible | echec, rien n'est ecrit |
| Deux bougies contradictoires pour un meme jour | echec, rien n'est ecrit |
| Jour hors plage renvoye par la pagination | ignore, ce n'est pas une anomalie |

## Format de sortie

`test/fixtures/candles-btc-usdc.csv` et `test/fixtures/candles-eth-usdc.csv` :

```
date,open,high,low,close
2024-01-01,42288.58,44240.8,42175.65,44220.78
```

Une ligne par jour, dans l'ordre croissant, sans doublon. Les valeurs sont les
chaines rendues par l'API, non reformatees.

## Regeneration

La fixture est versionnee et le rejeu ne fait aucun appel reseau. Relancer le
script telecharge a nouveau et peut donner un contenu different : l'historique
d'un exchange se revise.

Une regeneration change donc l'empreinte SHA-256 verrouillee par le test
d'integrite de la fixture. **C'est une PR consciente, jamais un effet de bord** :
tous les chiffres du rejeu bougent avec elle.

```
npx tsx scripts/build-fixture.ts --dry-run   # plan seul, aucun reseau, aucune ecriture
npx tsx scripts/build-fixture.ts             # telecharge, verifie, ecrit
```
