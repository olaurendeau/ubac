# Marge des delais de test

## Le probleme

`make coverage` est la porte qui fait respecter la regle non negociable
d'`AGENTS.md` : `src/core/risk.ts` couvert a 100 % lignes et branches. Elle est
tombee deux fois sur le meme motif.

1. Lot P7, `test/replay/report.test.ts` : les tests qui rejouent la fixture
   passaient de ~1,4 s a ~3,8 s par rejeu une fois le code instrumente par v8,
   et franchissaient le `testTimeout` global de 5 s. Porte cassee, franchement.
2. `test/replay/engine.test.ts` : meme cause, mais le test tenait a **7 % pres**
   sous la limite. Il passait — donc aucune alerte — et echouait des que la
   machine etait chargee. Une revue l'a vu echouer une fois, puis passer au
   second essai.

Le second cas est le plus couteux : une porte intermittente apprend a relancer
sans regarder, et le jour ou l'echec est reel il passe pour un flake.

## La regle

Un test lent recoit un **delai cible pose sur son bloc `describe`**, avec un
commentaire qui dit pourquoi ce test-la est lent.

Ne **jamais** relever `testTimeout` globalement. Un delai global genereux ferait
qu'un test reellement bloque n'importe ou ailleurs mettrait 30 s a echouer au
lieu de 5, degradant la detection dans toute la suite. Le delai cible est
verifiable : une sonde bloquee hors du bloc concerne echoue toujours a ~5 s,
y compris dans `test/replay/` mais hors du bloc porteur du delai.

Ne pas non plus reduire ce que le test verifie. Les six series de C29, le
determinisme octet pour octet et les metriques du moteur sont des criteres de
spec, pas une variable d'ajustement.

## Le garde-fou

`test/budget-reporter.ts` mesure, pour chaque test, la part de son **propre**
delai qu'il consomme — 5 000 ms par defaut, 30 000 ms dans un bloc a delai
cible. Il est branche a cote du reporter `default` dans `vitest.config.ts`.

| Part du delai consommee | Comportement |
| --- | --- |
| < 50 % | silence |
| >= 50 % | tableau affiche, run vert : il reste un facteur 2 |
| >= 80 % | run **rouge** : il ne reste qu'un facteur 1,25, le test est deja intermittent |

Son cout est assume : l'echec a 80 % est lui-meme sensible a la charge. Il est
accepte parce que le facteur necessaire pour l'atteindre est grand (le pire test
de la suite consomme 28 % de son delai, il lui faudrait ralentir de 2,8x) et
parce que l'evenement ainsi declenche est precisement celui qu'on veut voir, avec
un message qui nomme la cause au lieu d'un timeout nu.

## Marges mesurees

Pire test de chaque fichier, maximum sur 3 executions de `make coverage`
(instrumentation v8 comprise, c'est le regime le plus lent).

| Fichier (`test/`) | Pire test (ms) | Delai (ms) | Marge |
| --- | ---: | ---: | ---: |
| `replay/report.test.ts` | 8490 | 30000 | 72 % |
| `replay/engine.test.ts` | 4705 | 30000 | 84 % |
| `jobs/daily-main.test.ts` | 1729 | 30000 | 94 % |
| `jobs/purete.test.ts` | 1608 | 30000 | 95 % |
| `structure.test.ts` | 1051 | 5000 | 79 % |
| `core/benchmark-twr.test.ts` | 456 | 5000 | 91 % |
| `core/rebalance-band-edge.test.ts` | 364 | 5000 | 93 % |
| `core/rebalance-a.test.ts` | 253 | 5000 | 95 % |
| `core/portfolio.test.ts` | 214 | 5000 | 96 % |
| `core/rebalance-b.test.ts` | 195 | 5000 | 96 % |
| `adapters/coinbase.test.ts` | 172 | 5000 | 97 % |
| `fixtures/integrity.test.ts` | 112 | 5000 | 98 % |
| Les 20 autres fichiers | <= 32 | 5000 | >= 99 % |

Deux delais cibles sont arrives avec le lot Q4b1-bis, et la colonne « Delai »
est la clef de lecture de leurs deux lignes.

- `jobs/daily-main.test.ts` porte son delai **sur le bloc**, comme les deux
  fichiers de rejeu : chacune de ses sondes demarre un Node qui charge `tsx`,
  `ccxt` et `pg`, puisque le point d'entree du run ne peut pas etre importe
  (A22 de `test/jobs/purete.test.ts`) et ne s'eprouve qu'en processus.
- `jobs/purete.test.ts` le porte **sur un seul test**, pas sur son bloc : c'est
  la sonde d'A22 qui linte tout le TypeScript du depot, une soixantaine de
  fichiers contre trois pour les cinq autres gardiens. A 5 s elle consommait un
  tiers de son delai. Les 32 autres tests du fichier restent a 5 s, le pire
  d'entre eux a 369 ms, donc 93 % de marge : un delai pose sur le `describe`
  aurait relache leur detection sans raison.

Avant correctif, `replay/engine.test.ts` etait a **7 % de marge** (4640 ms pour
5000 ms). C'etait le seul fichier sous 50 % de marge ; aucun autre n'en approche.

Le tableau entier a ete remesure au lot Q4b1-bis, qui en change les lignes de
tete. La remesure a corrige au passage deux ecarts anterieurs : `structure.test.ts`
avait derive de 620 a 1051 ms, et `adapters/coinbase.test.ts`, a 172 ms, ne
tenait plus dans la ligne « les autres fichiers <= 42 ms » qui le comptait.

**Piege de lecture.** Le `testTimeout` s'applique **par test**, pas par fichier.
Le total affiche par vitest pour `report.test.ts` (~20 s) est la somme de ses six
tests ; son pire test unitaire est a 8,5 s. Comparer un total de fichier a une
limite par test conduit a soupconner un fichier sain et a manquer le vrai cas
limite — c'est exactement ce qui rendait `engine.test.ts` invisible.

## Refaire la mesure

```sh
./scripts/dev.sh npm run test:coverage -- --reporter=json \
  --outputFile.json=/workspace/.timings.json
```

Chaque entree de `testResults[].assertionResults[]` porte sa `duration`. Le
delai effectif d'un test est celui de son bloc, et le reporter le lit lui-meme
via `options.timeout`.
