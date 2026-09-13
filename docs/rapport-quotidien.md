# Rapport quotidien

Le rapport email de la spec §9. `src/report/daily-report.ts` le **rend** ;
l'envoi par l'API Brevo et le branchement dans le run quotidien appartiennent au
lot suivant. Rendre et envoyer sont séparés pour une raison précise : le rendu
est pur, donc il se compare à une sortie attendue sans réseau, sans clé et sans
run. `test/report/daily-report.test.ts` rend le rapport entier sur un état figé
et le compare ligne à ligne.

Le run quotidien est décrit dans [run-quotidien.md](run-quotidien.md) ; les
métriques que le rapport consomme viennent de `src/jobs/snapshot.ts`.

## 1. Condition de réception : SPF et DKIM

**Le domaine d'envoi doit être authentifié SPF et DKIM sur `olalpinesolutions`,
sinon les rapports finissent en spam** (§9). Ce n'est pas une affaire de code :
ce sont deux enregistrements DNS à poser, et c'est l'opérateur qui s'en charge
dans la console Brevo.

Aucun test de ce dépôt n'en dépend, et c'est délibéré : le rendu ne parle à
personne, et l'envoi sera testé contre un double de transport. Un rapport qui
part sans SPF ni DKIM part quand même — il arrive simplement en indésirable, ce
qu'aucune assertion locale ne peut constater.

## 2. Ce que le rapport contient

Les six points du §9, dans l'ordre où ils apparaissent :

| Section | Contenu | Source |
|---|---|---|
| En-tête | valeur totale, P&L jour et cumulé en TWR | `totalValue`, `portfolio_twr_index` |
| Distance au prochain déclenchement | poids USDC contre sa bande, ratio BTC/ETH contre la sienne quand B est armé | calculée par le rendu |
| Décision du jour | les quatre stratégies, `trigger NONE` compris, avec le verdict de risque | `outcomes` |
| Allocation | poids constatés contre cibles, et l'écart | `weights`, `params.targets` |
| Comparaison | TWR, max drawdown et Sharpe 90 j, portefeuille contre hold BTC et hold 50/50 ; ladder et DCA y figurent **sans courbe**, avec leur raison (section 6) | `snapshots.benchmarks` |
| Métriques indisponibles | ce que le noyau n'a pas pu rendre, et pourquoi | `benchmarkGaps` |

HTML en ligne, une colonne, largeur maximale de 520 px : ni feuille de style, ni
image, ni police distante. Un client mobile qui bloque les ressources externes —
c'est le défaut de la plupart — rend le même rapport. Le corps est **sans
accent**, comme les `reason` du noyau qu'il cite telles quelles.

Tag `daily-report` sur chaque envoi (§9), figé dans `REPORT_TAG` et consommé par
l'envoi : deux littéraux divergeraient.

### Un rapport part même quand rien ne se passe

`renderDailyReport` rend un courrier pour tout run achevé. Aucune branche ne rend
`undefined`, et l'objet du message dit ce qui s'est passé :

```
Ubac 2026-09-13 — 100000.00 USDC — aucun declenchement
Ubac 2026-09-13 — 100000.00 USDC — CASH_BAND, 2 jambe(s)
Ubac 2026-09-13 — 100000.00 USDC — SUSPENDU (recul -26.12 %)
```

Un run sans action doit laisser une trace : sans elle, l'opérateur ne distingue
pas un système qui n'a rien eu à faire d'un système qui n'a pas tourné. La
surveillance de l'absence, elle, ne passe pas par le mail — c'est le healthcheck
du §9, et il appartient au lot Q6.

## 3. La distance au prochain déclenchement

C'est « l'information la plus utile du rapport : elle dit quand quelque chose va
se passer » (§9). C'est aussi **la seule valeur que le noyau ne produit pas** :
`decide()` dit si la bande est franchie, jamais de combien il s'en faut. Donc la
seule qui puisse être fausse sans qu'aucun test du noyau ne bronche, d'où
`bandDistance` exportée et sondée aux bornes, des deux côtés.

Elle s'exprime **sur l'axe de la bande**, pas en variation de prix : une marge de
poids en points de pourcentage, une marge de ratio en unités de ratio. Convertir
en « de combien la crypto doit bouger » est une seconde métrique, utile mais non
livrée : elle est indéfinie dès que la ligne crypto est vide, et une promesse
plus modeste et entièrement vraie vaut mieux qu'une promesse partiellement
vérifiée.

Trois cas, tranchés ici parce que le §9 ne les tranche pas :

| Position | Statut rendu | Ce que le rapport affiche |
|---|---|---|
| Dans la bande | `INSIDE` | la plus courte des deux marges, et la borne qu'elle désigne |
| **Exactement sur une borne** | `INSIDE`, `onEdge` | « sur la borne — la bande est fermee, le moindre pas au-dela declenche » |
| **Déjà hors bande** | `CROSSED` | « franchie — X au-dela de la borne » : le dépassement, pas une distance |

**Sur une borne, rien n'est encore déclenché.** Les bornes sont dans la bande
(C6) : `decide()` tire strictement sous la borne basse et strictement au-dessus
de la haute, jamais dessus. Rendre `CROSSED` avancerait le déclenchement d'un
jour ; afficher « 0.00 pt » sans le drapeau laisserait croire à un arrondi.

**Déjà hors bande, il n'y a plus de distance à parcourir.** Afficher zéro
confondrait « au bord » et « dehors », qui appellent des lectures opposées :
l'un annonce, l'autre constate. La valeur utile devient alors le dépassement.

À égalité parfaite des deux marges, c'est la borne **basse** qui est désignée.
Choix arbitraire mais déterministe : un rapport se rejoue à l'identique.

Le garde-fou qui tient tout cela n'est pas une relecture : `bandDistance` écrit
les mêmes comparaisons que `locate()` — `lt` et `gt`, jamais `lte` ni `gte` — et
un test confronte son verdict à celui de `decide()` sur le même état, aux deux
bornes et de part et d'autre. Une inversion ferait diverger les deux.

## 4. Le P&L est un TWR, jamais une variation de valeur

Un apport de 10 000 USDC se lirait sinon comme une performance : c'est l'objet du
critère C27 de la phase 0.

- **Cumulé** : l'indice de croissance moins 1. L'indice vaut 1 à la première
  photo et ne bouge que des rendements, flux exclus — `indice - 1` *est* le TWR
  depuis l'origine, au même titre que `timeWeightedReturn` rend son produit moins
  1. Changement d'unité, pas second calcul.
- **Du jour** : le quotient de deux indices consécutifs, moins 1. Les deux sont
  chaînés flux exclus, donc leur quotient l'est aussi.

Le P&L du jour demande donc la photo de la veille. Elle est **strictement
antérieure** ou il n'est pas rendu : un second run du même jour relit la photo du
jour, le quotient vaudrait exactement 1, et le rapport annoncerait une journée
plate qui n'a pas eu lieu. Sans photo de référence, la case dit « indisponible »
et la note dit pourquoi — elle ne se replie jamais sur la valeur brute.

## 5. Ce que le rapport ne peut pas dire, et pourquoi

Une métrique absente se dit absente, **avec son motif**, jamais par un zéro : un
Sharpe à 0 se lirait « performance neutre constatée », un drawdown à 0 se lirait
« tout va bien ». Les motifs viennent de `benchmarkGaps`, pas d'une phrase
inventée par le rendu.

Quatre absences sont structurelles en phase 1 :

- **Max drawdown et Sharpe du portefeuille.** La photo porte l'indice et son
  sommet, pas la série ; ni le pire recul passé ni un écart-type ne s'en lisent.
  Ce qui est rendu, et nommé comme tel, est le **recul actuel depuis le plus
  haut** — celui que la règle de suspension du §6 applique. Ce n'est pas un max
  drawdown, et l'appeler ainsi serait faux.
- **Courbes ladder et DCA.** `snapshot.ts` ne les écrit pas. C'est un écart
  assumé avec le §9 de la spec, traité à part en section 6 : le rapport le dit
  dans le tableau de comparaison, pas seulement ici.
- **Les deux fenêtres ne coïncident pas.** Les hold sont dérivés de la fenêtre
  OHLCV du run ; l'indice du portefeuille est chaîné depuis la première photo.
  Tant que le système n'a pas tourné aussi longtemps que la fenêtre, les colonnes
  mesurent des périodes différentes. Le rapport le dit sous le tableau plutôt que
  d'aligner deux chiffres qui ne se comparent pas.
- **Aucune version texte.** Le courrier est HTML seul. Une alternative `text/plain`
  aiderait la délivrabilité ; elle n'est pas livrée.

## 6. Écart assumé avec le §9 : ni courbe ladder, ni courbe DCA

### La divergence

| Source | Ce qui est dit, ce qui est fait |
|---|---|
| `docs/specs/ubac-rebalance.md` §9 | « Comparaison au hold BTC, au hold 50/50, au **ladder shadow** et au **DCA shadow**. » |
| `docs/specs/ubac-rebalance.md` §4, `snapshots.benchmarks` | `{hold_btc, hold_5050, ladder, dca}` |
| `src/jobs/snapshot.ts` | écrit `hold_btc` et `hold_5050` ; les clés `ladder` et `dca` sont **absentes**, pas nulles |
| `src/report/daily-report.ts` | rend les quatre lignes ; les deux ombres portent leur raison à la place des chiffres |

### Pourquoi les deux courbes ne sont pas écrites

**En phase 1, aucune stratégie ne place d'ordre.** Les trois portefeuilles
simulés seraient donc le portefeuille réel, au centime près, et trois courbes
identiques feraient lire une comparaison là où il n'y en a aucune. Le §9 attend
quatre comparaisons parce qu'il décrit un système qui exécute ; tant qu'il
observe, deux d'entre elles n'ont rien à comparer.

Rendre ces colonnes serait **pire que de ne pas les rendre** : une comparaison
fausse, affichée comme une information de confiance sur un téléphone. Un
opérateur qui lit « ladder +25,00 % » à côté de « portefeuille +25,00 % » en
conclut que sa stratégie fait jeu égal avec son benchmark, alors qu'il regarde
deux fois le même chiffre.

### Pourquoi le rapport le dit quand même, et dans le tableau

Une absence sans motif, à l'endroit où l'opérateur cherche l'information, se lit
comme une panne. Les deux lignes figurent donc **dans le tableau de
comparaison** — `Ladder (ombre)` et `DCA (ombre)` —, et la raison occupe les
trois colonnes de métriques :

```
Ladder (ombre) | sans courbe en phase 1 : aucune strategie n'execute,
                 son portefeuille simule serait le portefeuille reel
```

Ni chiffre, ni « indisponible » : « indisponible » annoncerait un trou de la
photo, réparable, alors que c'est une absence assumée. Leur **décision du jour**
figure bien au rapport, une section plus haut — ce qui est observable l'est.

Deux sondes tiennent cette affirmation dans `test/report/daily-report.test.ts` :
l'une constate que la mention est bien dans le tableau, entre les hold et les
notes ; l'autre qu'aucune courbe n'est fabriquée — les lignes d'ombre ne portent
aucun nombre, et planter une clé `ladder_twr` dans la photo ne change pas un
octet du rendu.

### Ce qui lèverait l'écart

Une **simulation des ombres au jour le jour** : faire tourner ladder et DCA sur
un portefeuille simulé propre à chacun, chaîné de photo en photo. C'est ce que
le rejeu historique fait déjà sur une période passée — `src/replay/engine.ts`,
résultats dans [resultats-phase-0.md](resultats-phase-0.md) ; l'amener dans le
run quotidien n'appartient pas à la phase 1. Le jour où ces courbes existeront, les
deux lignes devront prendre leurs chiffres, et la seconde sonde est ce qui le
rappellera.

`docs/specs/ubac-rebalance.md` n'est **pas** modifiée. Aligner la spec sur ce
choix est une décision de l'opérateur, pas un ajustement technique de ce lot :
la divergence est signalée ici, elle n'est pas tranchée ici.

## 7. Le rendu ne connaît pas le run

`eslint.config.js` interdit à `src/report/` d'importer `src/jobs/`, et la règle a
raison : un rendu qui importerait le run ne se testerait plus sans monter un run.
`CompletedRun` est donc une forme déclarée dans le rendu, que `DailyRunResult`
satisfait.

« Structurellement compatible » est exactement le genre de promesse qui devient
fausse en silence, alors elle est fermée par le typage et non par la convention :
`test/report/contrat-run.test-d.ts` assigne le résultat du run à la forme du
rendu, champ par champ et branche par branche, et refuse un run abandonné. Une
divergence fait échouer `make typecheck` chez celui qui l'a introduite.

Même motif pour les clés de `snapshots.benchmarks`, recopiées faute de pouvoir
être importées : un rapport qui lirait `holdbtc_twr` pendant que la photo écrit
`hold_btc_twr` n'afficherait pas une erreur, il afficherait « indisponible ». Un
test confronte les deux tables.
