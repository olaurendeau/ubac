# Source de la fixture de bougies

La spec `ubac-phase-0.md` liste « la fixture de bougies n'est pas auditée » parmi ses
zones d'incertitude assumées : source, fuseau de clôture et traitement des trous n'y
sont pas spécifiés, et deux sources différentes donnent des résultats de rejeu
différents sans qu'il s'agisse d'un bug. Cette note fige les trois, une fois.

Elle est le contrat ; `scripts/build-fixture.ts` en est l'implémentation et
`src/fixture/normalise.ts` en est le contrôle. Toute divergence entre les trois est un
défaut, quel que soit celui des trois qui a raison.

## Source

| | |
|---|---|
| Fournisseur | **Coinbase Advanced Trade**, données de marché publiques |
| Point d'entrée | `GET https://api.coinbase.com/api/v3/brokerage/market/products/{product_id}/candles` |
| Authentification | **aucune** — pas de clé, pas de signature, pas de secret dans le dépôt |
| Produits | `BTC-USDC` et `ETH-USDC` |
| Granularité | `ONE_DAY` |
| Plage | **2024-01-01 → 2026-08-31**, bornes incluses, soit **974 jours** |
| Pagination | 300 jours par requête ; l'API refuse au-delà de 350 |

Coinbase est retenu parce que c'est la même maison que celle qui exécutera les ordres
en phase 3 : le rejeu et la production lisent le même carnet. Une source tierce
(CoinGecko, Kraken, Binance) donnerait des bougies proches mais pas identiques —
carnets différents, agrégations différentes — et l'écart se lirait comme un écart de
stratégie dans le tableau comparatif.

Le champ `product_id` est libellé en **USDC**, jamais en USD ni en EUR. `BTC-USD` et
`BTC-USDC` sont deux carnets distincts chez Coinbase, à quelques points de base l'un de
l'autre ; la spec cote tout en USDC et la fixture suit.

## Fuseau de clôture

**Les bougies journalières ouvrent à 00:00:00 UTC et clôturent à 24:00:00 UTC.** Pas
d'heure locale, pas d'heure de New York, pas de bascule d'heure d'été.

C'est le point qui casse le plus silencieusement. Une source qui clôture en heure locale
décale toute la série d'un fuseau : aucun test du rejeu n'échoue, tous les résultats
changent. Le contrôle n'est donc pas ici, dans une note que personne n'exécute — il est
dans `src/fixture/normalise.ts`, atteignable depuis un test :

- `TIMESTAMP_NOT_UTC_MIDNIGHT` — l'horodatage d'ouverture n'est pas un multiple de
  86 400 s. C'est le contrôle du fuseau lui-même.
- `TIMESTAMP_OUT_OF_RANGE` — l'horodatage n'est pas un nombre de secondes plausible
  (2009-01-01 à 2100-01-01). L'alignement sur 86 400 s est aveugle à l'unité : une
  valeur en millisecondes reste multiple de 86 400. Ce sont les bornes qui attrapent
  une source qui changerait d'unité.

Le champ `date` du CSV est le **jour d'ouverture** de la bougie, au format `YYYY-MM-DD`,
en UTC.

## Politique de trous

**Aucun remplissage. Un jour manquant refuse la série entière.**

Ni report de la clôture de la veille, ni interpolation, ni saut du jour. Une bougie
inventée est indiscernable d'une vraie une fois dans le CSV, et elle fausse en silence
tous les chiffres du tableau comparatif — valeur finale, TWR, Sharpe, drawdown,
nombre de déclenchements.

Le refus est porté par `DAY_MISSING` dans `src/fixture/normalise.ts`, contre le
calendrier construit par `expectedCalendar('2024-01-01', '2026-08-31')`. Le message
nomme les jours absents. Les marchés crypto cotent 7 j/7 : un trou n'est pas un week-end,
c'est une panne de la source ou un produit qui n'existait pas encore.

Les autres causes de refus suivent la même règle du tout ou rien :

| Code | Cause |
|---|---|
| `PRICE_NOT_POSITIVE` | un prix nul, négatif, infini ou `NaN` |
| `DUPLICATE_MISMATCH` | deux bougies du même jour aux valeurs différentes |
| `CANDLE_MALFORMED` | champ absent, prix publié en nombre JSON plutôt qu'en chaîne |

Un prix publié en nombre JSON est refusé : il est déjà passé par un flottant binaire
avant qu'on le voie, donc sa valeur d'origine n'est plus vérifiable. C'est la règle
« aucun `number` flottant sur un prix » de `CLAUDE.md`, appliquée à la frontière.

## Format des fichiers écrits

```
test/fixtures/candles-btc-usdc.csv
test/fixtures/candles-eth-usdc.csv
```

En-tête `date,open,high,low,close`, puis un jour par ligne, dans l'ordre croissant des
dates, sans trou. Fins de ligne LF, retour à la ligne final, encodage UTF-8. 975 lignes
par fichier : 1 en-tête + 974 jours.

Les prix sont repris **verbatim** de la source, jamais reformatés. Les reformater
depuis un `Decimal` leur ferait perdre des chiffres au passage et la fixture ne serait
plus comparable ligne pour ligne à ce que l'API renvoie. Le volume n'est pas conservé :
aucune stratégie de la phase 0 ne le lit.

## Régénérer

Pas de `npm` / `node` sur le host : tout passe par Docker.

```sh
./scripts/dev.sh npx tsx scripts/build-fixture.ts --dry-run   # télécharge, valide, n'écrit rien
./scripts/dev.sh npx tsx scripts/build-fixture.ts             # écrit les deux CSV
```

L'écriture est **tout ou rien** : les deux actifs sont téléchargés et validés
intégralement avant que le premier octet ne touche le disque, via des fichiers
temporaires renommés. Un échec sur ETH ne laisse pas une fixture à moitié régénérée.

Une régénération qui change les octets change l'empreinte SHA-256 vérifiée par
`test/fixtures/integrity.test.ts`. Ce doit être une PR consciente, avec la raison du
changement, **jamais un effet de bord** d'une autre étape. Une source qui réécrit son
historique a posteriori est une raison valable ; « j'ai relancé le script » n'en est pas
une.
