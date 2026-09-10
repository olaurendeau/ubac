# Résultats du rejeu — phase 0

Généré le 2026-09-10 sur `main`, commit `12cbac0`.
Reproductible par `make ci` puis `./scripts/dev.sh npm run replay`.

## Ce que ce document est, et ce qu'il n'est pas

Il détaille la sortie du harnais de rejeu et explique chaque terme employé.

Il **ne classe pas les stratégies**. Le critère C31 de
[la spec](specs/ubac-phase-0.md) l'interdit explicitement : le rejeu sert à
prouver que le rapport est produit et déterministe, jamais qu'une stratégie en
bat une autre. Aucun seuil de performance n'est un critère de succès de la
phase 0. Les chiffres ci-dessous mesurent un régime de marché de 32 mois autant
qu'ils mesurent une stratégie.

## Le cadre du rejeu

| | |
|---|---|
| Période | 2024-01-01 → 2026-08-31, bornes incluses, **974 jours** |
| Actifs | BTC-USDC et ETH-USDC, bougies journalières clôturant à 00:00 UTC |
| Source | Coinbase Advanced Trade, endpoint public, empreintes SHA-256 figées |
| Trous | aucun remplissage : un jour manquant refuse la série entière |
| Capital initial | 5 000 USDC au 2024-01-01 |
| Apports | 500 USDC le 1er de chaque mois, 32 apports |
| Retrait | 1 000 USDC le 2025-06-15, mouvement unique |
| **Net apporté** | **20 000 USDC** |

Les six séries partent du même capital et reçoivent les mêmes flux, aux mêmes
dates. Seule la manière d'employer le cash change.

## Le tableau

```
serie           valeur_finale   twr        sharpe_90j   max_drawdown   declenchements
rebalance          23368.54     0.446203    2.181820      -0.457047        12
rebalance_ab       23430.45     0.449910    2.181752      -0.451144        14
ladder             20985.00     0.068455    2.181232      -0.048270        27
dca                20064.33     0.060182    2.141429      -0.503161        32
hold_btc           25099.90     0.776602    1.916047      -0.530758         0
hold_50_50         22152.77     0.412641    2.085464      -0.586363         0
```

Écart entre valeur finale et net apporté, à titre indicatif — ce n'est pas une
mesure de performance, voir le lexique sur ce point :

| série | valeur finale | écart au net apporté |
|---|---:|---:|
| `hold_btc` | 25 099,90 | +5 099,90 |
| `rebalance_ab` | 23 430,45 | +3 430,45 |
| `rebalance` | 23 368,54 | +3 368,54 |
| `hold_50_50` | 22 152,77 | +2 152,77 |
| `ladder` | 20 985,00 | +985,00 |
| `dca` | 20 064,33 | +64,33 |

## Série par série

### `rebalance` — la configuration de production

Cibles **BTC 40 % / ETH 30 % / USDC 30 %**, bande cash relative de ±20 %, donc
aucun tir tant que le poids du cash reste dans `[0,24 ; 0,36]`. Mode `target` :
quand la bande est franchie, retour à la cible exacte. Déclencheur B désarmé.

12 déclenchements en 32 mois, soit un tous les deux mois et demi environ.

### `rebalance_ab` — la même, déclencheur B armé

Identique, sauf que le **déclencheur B** est actif : arbitrage BTC contre ETH
quand leur ratio sort d'une bande de ±30 %, à ligne cash inchangée, avec son
propre cooldown de 7 jours. Le déclencheur A reste prioritaire.

14 déclenchements contre 12, soit **2 arbitrages de ratio sur 32 mois**. Le
cadrage avait sorti B de la production faute de P&L attribuable à 1 à 3
événements par an ; le rejeu donne exactement cet ordre de grandeur.

### `ladder` — stratégie d'ombre

Ancre unique par actif. Achat quand le cours passe à **-7 % de l'ancre pour BTC**
ou **-9 % pour ETH**, vente à **+12 %** et **+15 %**. Tranches de **500 USDC**,
au plus une par actif et par jour. L'ancre ne bouge que lorsqu'une tranche part.

27 déclenchements, et le plus faible drawdown du tableau : **-4,8 %**, contre
-45 % à -59 % ailleurs. C'est **structurel, pas une qualité** : le ladder
n'engage que des tranches de 500 USDC et laisse le reste en cash. Il est peu
exposé, donc il chute peu et monte peu. Comparer son drawdown à celui de
`hold_btc` compare deux niveaux d'exposition, pas deux qualités de stratégie.

### `dca` — stratégie d'ombre

**500 USDC le 1er de chaque mois**, répartis BTC puis ETH. Si le jour choisi
n'existe pas dans le mois, repli sur le dernier jour du mois.

32 déclenchements, soit exactement un par mois sur 32 mois.

### `hold_btc` et `hold_50_50` — les deux repères

`hold_btc` place tout en BTC, `hold_50_50` répartit moitié BTC moitié ETH.
Aucun mouvement ensuite. **Zéro déclenchement par construction** : ce sont des
repères de comparaison, pas des stratégies.

## Lexique

### Les métriques du tableau

**Valeur finale** — la valeur du portefeuille en USDC au dernier jour de la
fixture, le 2026-08-31. Elle inclut tout : le capital initial, les apports, les
plus ou moins-values. Une valeur finale de 23 368 sur 20 000 apportés ne veut
pas dire « +16,8 % de performance » : une partie de ces 20 000 n'a été apportée
que quelques mois avant la fin et n'a pas eu le temps de travailler. C'est
exactement ce que le TWR corrige.

**TWR — *time-weighted return*, rendement pondéré par le temps** — la
performance de la stratégie **débarrassée de l'effet des apports et des
retraits**. La série de valeurs est découpée en sous-périodes bornées par chaque
mouvement de trésorerie ; le rendement de chaque sous-période est calculé, puis
les sous-périodes sont chaînées. Résultat : verser 500 USDC de plus ne change
pas le TWR, alors que cela change la valeur finale.

C'est la mesure qui répond à « est-ce que la stratégie a bien travaillé », par
opposition à « combien ai-je à la fin ». Un TWR de `0.446203` se lit **+44,6 %**
sur toute la période. Le critère C27 le vérifie sur un cas limite : un apport
sur un portefeuille dont les prix n'ont pas bougé donne un TWR de 0.

**Sharpe 90 j** — le rapport entre le rendement moyen et sa volatilité, sur une
fenêtre glissante de 90 jours. Formule employée ici : moyenne des rendements
journaliers de la fenêtre, moins un taux sans risque **fixé à 0**, divisée par
l'écart-type d'échantillon de ces rendements, le tout annualisé en multipliant
par `√365`.

Plus le chiffre est haut, plus le rendement obtenu l'a été de façon régulière.
Un Sharpe de 2 indique un rendement deux fois supérieur à sa propre volatilité,
en rythme annuel.

> **Piège de lecture, important.** La valeur affichée est le **dernier point**
> de la série glissante, pas une moyenne sur toute la période. Elle décrit donc
> les **90 derniers jours** de la fixture, soit environ juin à août 2026, et rien
> d'autre. C'est ce qui explique que `rebalance`, `rebalance_ab` et `ladder`
> affichent 2,18 alors que leurs drawdowns vont de -4,8 % à -45,7 % : sur cette
> dernière fenêtre, leurs dynamiques se ressemblent. Sur les 120 derniers jours,
> les mêmes séries donnent 1,99 et 3,14. La colonne ne résume pas la période.

**Max drawdown — perte maximale depuis un sommet** — la plus forte baisse
subie entre un point haut et le point bas qui le suit, en pourcentage du point
haut. `-0.457047` se lit **-45,7 %** : à un moment de la période, le
portefeuille valait 45,7 % de moins que son meilleur niveau atteint jusque-là.

C'est une mesure de ce qu'il faut encaisser, pas de ce qu'on gagne. Elle ne dit
pas quand c'est arrivé ni combien de temps ça a duré.

**Déclenchements** — le nombre de fois où la stratégie a produit au moins une
jambe sur la période. Un run qui décide de ne rien faire ne compte pas. Les
benchmarks `hold` sont à zéro par construction.

### Le vocabulaire du projet

**USDC** — le *stablecoin* adossé au dollar qui sert de monnaie de compte à tout
le projet. Le cash est exclusivement en USDC, jamais en euro ni en dollar
« classique ». `BTC-USD` et `BTC-USDC` sont deux carnets d'ordres distincts chez
Coinbase, à quelques points de base l'un de l'autre.

**Jambe** — un ordre élémentaire dans une intention de rééquilibrage :
« acheter pour 800 USDC de BTC » est une jambe. Un rééquilibrage complet en
produit typiquement deux ou trois. Une intention peut être partiellement filtrée
sans être rejetée : une jambe sous 200 USDC est ignorée, les autres passent.

**Poids** — la part d'un actif dans la valeur totale du portefeuille, entre 0
et 1. Les trois poids somment à 1.

**Cible** — le poids visé pour chaque actif. Ici BTC 0,40 / ETH 0,30 /
USDC 0,30.

**Bande** — la zone de tolérance autour d'une cible, dans laquelle on ne fait
rien. Une bande cash **relative** de ±20 % autour d'une cible de 0,30 donne
`[0,24 ; 0,36]`. Tant que le poids du cash reste dedans, aucun ordre. Elle évite
de réagir à chaque oscillation.

**Déclencheur A** — la règle qui surveille la **bande cash**. C'est le
déclencheur de production.

**Déclencheur B** — la règle qui surveille le **ratio BTC/ETH** et arbitre l'un
contre l'autre sans toucher à la ligne de cash. Il est désarmé en production ; le
cadrage l'a écarté faute de P&L attribuable à 1 à 3 événements par an. Il n'est
armé que sur la configuration d'ombre `rebalance_ab`.

**Mode `target` et mode `band_edge`** — deux façons de revenir dans la bande une
fois franchie. `target` ramène à la cible exacte (cash à 0,30). `band_edge`
ramène seulement au bord franchi : un cash tombé à 20 % remonte à 24 %, un cash
monté à 40 % redescend à 36 %. Le second échange moins, donc coûte moins de
frais, mais reste plus près du bord.

**Cooldown** — le délai minimum entre deux déclenchements, pour éviter de
tirer plusieurs fois sur le même mouvement de marché. Il n'est armé que par un
rééquilibrage complet réussi : un run qui suit une exécution partielle n'est pas
bloqué. Le déclencheur B a son propre cooldown, de 7 jours, indépendant.

**Carence** — le gel du déclencheur A pendant les 7 jours qui suivent un apport,
borne exclusive : un apport le 1er gèle A jusqu'au 8 exclu. Elle évite de
rééquilibrer sur un portefeuille temporairement déformé par de l'argent frais.
Le gel ne porte que sur A : B continue d'être évalué, puisqu'il arbitre à ligne
cash inchangée et ne peut donc pas investir l'apport.

**Ancre** *(ladder)* — le cours de référence à partir duquel le ladder mesure
les écarts. Elle est posée au cours de clôture du premier jour et ne bouge que
lorsqu'une tranche part, moment où elle est reposée au cours du jour.

**Tranche** *(ladder)* — le montant fixe engagé à chaque franchissement, ici
500 USDC. Au plus une par actif et par jour : un effondrement de 30 % dans la
journée vaut quatre pas de 7 %, le ladder n'achète qu'une tranche.

**DCA — *dollar cost averaging*** — investir un montant fixe à intervalle fixe,
sans regarder le cours. Ici 500 USDC le 1er de chaque mois.

**Stratégie d'ombre — *shadow*** — une stratégie calculée et mesurée par le
rejeu mais qui ne passerait aucun ordre en production. Elle sert de point de
comparaison. `ladder`, `dca` et `rebalance_ab` sont en ombre ; seule
`rebalance` est la configuration de production.

**Benchmark `hold`** — un repère passif : on achète une fois selon une
répartition donnée et on ne touche plus à rien. `hold_btc` est 100 % BTC,
`hold_50_50` est moitié-moitié.

**Déterminisme** — la propriété qu'exige le critère C30 : deux exécutions du
rejeu sur la même fixture produisent une sortie **identique octet pour octet**.
C'est ce qui rend une comparaison de stratégies interprétable ; sans elle, un
écart entre deux tableaux pourrait venir du hasard d'exécution plutôt que d'une
différence réelle. L'horloge est injectée depuis la fixture, jamais lue sur le
système.

**Fixture** — le jeu de données figé et versionné sur lequel tourne le rejeu :
les bougies et les flux. Ses empreintes SHA-256 sont vérifiées par un test ;
toute régénération les change et doit être une modification consciente, jamais
un effet de bord.

## Comment ne pas surinterpréter ce tableau

**32 mois, un seul régime de marché.** La période retenue couvre une hausse
marquée du BTC. Toute stratégie qui réduit l'exposition y paraît mauvaise, et le
`hold_btc` y paraît excellent. Sur une période baissière, l'ordre s'inverserait
en grande partie. Ce tableau ne prédit rien.

**Le Sharpe affiché ne couvre que les 90 derniers jours.** Voir le piège de
lecture ci-dessus. Ne pas le lire comme une qualité moyenne sur la période.

**Les frais ne sont pas modélisés en phase 0.** Une stratégie à 32
déclenchements et une stratégie à 12 ne paient pas le même coût de transaction ;
le tableau ne le reflète pas.

**Le drawdown dépend de l'exposition avant de dépendre de la stratégie.** Le
`ladder` laisse la majeure partie du capital en cash : son -4,8 % n'est pas une
protection habile, c'est de la non-exposition.

**Aucun de ces chiffres n'est un critère de succès.** Ce que la phase 0 valide,
c'est que le noyau est correct, que la couche risque est couverte à 100 % sans
contournement, et que le rapport est produit et reproductible. Pas qu'une
stratégie soit la bonne.
