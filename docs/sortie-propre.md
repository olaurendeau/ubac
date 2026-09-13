# Sortie propre

`src/jobs/liquidate.ts` implémente la procédure de sortie de la spec §14 :
annuler les ordres ouverts, liquider les positions vers USDC, désactiver le cron
quotidien, rendre un rapport. Elle est écrite dès la phase 1 — « le jour où on
veut arrêter, on n'improvise pas un script à la main » — et **elle ne peut pas
s'appliquer**.

Lot Q7, décision préalable D3. Références : spec §7, §11, §13 et §14 ;
`docs/phase-1-frontieres.md` pour les garde-fous que ce lot franchit.

## 1. Ce que ce lot livre

| Étape de la spec §14 | État |
|---|---|
| 1. Annulation de tous les ordres ouverts | **intention calculée**, non appliquée |
| 2. Liquidation des positions vers USDC en limit post-only | **intention calculée**, non appliquée |
| 3. Désactivation du cron trigger | **intention calculée**, non appliquée |
| 4. Rapport final récapitulant les cessions | calculé, marqué `PROJETE` |

`planifierSortie` rend un `PlanDeSortie` : les trois premières étapes en
séquence d'intentions ordonnée, la quatrième en rapport. `appliquerSortie` est le
point que la commande de sortie appellerait ; il rend **toujours** un refus, avec
le plan attaché.

La commande CLI et le bouton ntfy du §14 **n'existent pas**. Ils supposeraient un
second point d'entrée composant les adapters, et `test/jobs/purete.test.ts` (A20,
A22) réserve cela à `src/jobs/daily-main.ts`. Ouvrir un second lieu de
composition est une décision du coordinateur, pas un ajustement technique.

## 2. Le garde-fou de phase, franchi sans être affaibli

`eslint.config.js` interdit dans `src/adapters/**` et `src/jobs/**` tout nom qui
dénote un placement, une annulation ou un retrait. Ce lot décrit précisément ces
opérations. Le conflit est résolu par la conception, pas par une exception :

**le module ne fait aucun appel.** Il calcule et rend des données. C'est la même
forme que `src/jobs/reconcile.ts`, qui calcule les transitions d'ordres sans en
persister aucune, et qui a été accepté pour cette raison. Un exécuteur de phase 3
consommera `plan.intentions` ; il vivra ailleurs et sera relu pour lui-même.

Ni `eslint.config.js` ni `test/jobs/purete.test.ts` ne sont modifiés par ce lot.
Les cinq garde-fous existants s'appliquent au fichier livré et restent verts :
pas d'horloge (A5-A7), pas de `process` ni de `crypto` (A8-A12), pas
d'environnement (A13-A18), `reconcile.ts` reste le seul lecteur de soldes (A19),
`daily-main.ts` reste le seul composeur d'adapters (A20).

Le vocabulaire du module est en français, comme le reste du dépôt. Ce n'est pas
la raison pour laquelle il passe le lint : un `ANNULER_ORDRE` qui porterait un
appel serait un contournement, quel que soit son nom. Ce qui le fait passer est
qu'il n'y a aucun appel à nommer — constaté par les sondes V6 et V7.

## 3. Le verrou

Il n'a **aucun paramètre**. Pas de drapeau, pas de variable d'environnement, pas
de `--force`, pas d'argument caché. Onze propriétés le tiennent, chacune sondée
par `test/jobs/liquidate-verrou.test.ts` :

| # | Propriété | Sonde |
|---|---|---|
| V1 | `appliquerSortie` rend toujours `VERROUILLE` | 5 entrées, du portefeuille vide à celui chargé d'ordres |
| V2 | aucun argument ne lève le refus | 7 arguments surnuméraires + 1 entrée enrichie, par une référence détypée |
| V3 | aucune variable d'environnement ne le lève | 8 noms plausibles, séparément puis ensemble |
| V4 | aucune forme d'appel ne le lève | direct, `call`, `apply`, `Reflect.apply`, méthode, fonction détachée |
| V5 | le refus porte le plan de `planifierSortie`, et rien d'autre | égalité + énumération des champs rendus |
| V6 | le module est **synchrone** | 7 formes asynchrones sondées, puis le fichier livré |
| V7 | ses imports sont énumérés | 10 formes sondées ; 8 déclarations livrées, liste blanche, adapters en type, `validate` refusé |
| V8 | la surface publique est exactement celle-ci | 9 noms, énumérés |
| V9 | aucune chaîne de contournement dans le source | `dryRun`, `force`, `bypass`, `skip`, `override`, `unlock` |
| V10 | quatre affirmations de **type** tenues à chaque `tsc` | 3 `@ts-expect-error` + 1 affectation qui échoue si un port apparaît |
| V11 | le fichier livré est **dans le périmètre** des garde-fous du dépôt | le glob le lit ; la config réelle mord à cet emplacement et se tait sur lui |

Le cœur est V6 et V7. **Une fonction qui ne sait pas attendre ne sait pas parler à
un exchange** : ni `async`, ni `await`, ni `Promise`, ni import dynamique, et
aucun module à effet dans la liste d'imports. Le reste — V1 à V5 — dit que le
refus est une décision et non une omission.

V11 existe parce que « les garde-fous s'appliquent au fichier livré » serait
sinon une affirmation invérifiable : un fichier hors périmètre produit exactement
le même « aucune erreur » qu'un fichier propre. La sonde constate d'abord que la
règle d'écriture d'ordre **mord** à cet emplacement, puis qu'elle se tait sur le
fichier.

`SortieVerrouillee` n'est **pas une union** : il n'existe aucun type pour une
sortie appliquée. Armer la sortie demande d'écrire ce type, le chemin qui y mène
et le port qui l'applique, donc un lot de phase 3 relu. Le verrou ne se lève pas,
il se retire.

`PHASE_COURANTE` et `PHASE_D_APPLICATION` ne pilotent aucune condition. Ce sont
les valeurs que le refus cite pour dire pourquoi il refuse. Les poser à 3 ne
débloquerait rien, et c'est voulu : un verrou qu'une constante ouvre est un
drapeau.

### Ce que le verrou ne prouve pas

- **V9 est un garde-fou grossier et contournable**, exactement du même statut que
  le test de contrat de `src/core/risk.ts` : une recherche de chaînes se
  contourne en nommant la porte autrement. Ce n'est pas une preuve.
- **V6 et V7 sont des contrôles de noms sur l'arbre syntaxique.** Un effet passé
  par un module de `core/` qui ferait l'appel lui-même leur échapperait — même
  limite que celle écrite dans `docs/phase-1-frontieres.md`.
- **Rien ici ne prouve l'absence d'exécution.** La seule garantie structurelle
  reste celle du §7 : une clé scopée sur un portefeuille dédié, sans permission
  de retrait, et en phase 1 sans permission de trade.

Les deux premières limites sont **constatées** et non seulement déclarées : W1
sonde une porte nommée autrement, W2 sonde un relais par un module de `core/`.
Le jour où l'une se ferme, son test devient rouge — c'est le signal.

## 4. Les contraintes métier reprises, et celles qui ne s'appliquent pas

### Reprises

- **Contrepartie USDC exclusivement (§11).** Une cession vers EUR est un fait
  générateur d'imposition en France. La contrepartie vient de `core/risk.ts` et
  le type `Order` du noyau la fige sur le littéral `'USDC'` : `quote: 'EUR'` ne
  compile pas. Un solde EUR à l'entrée ne produit aucune ligne ; un ordre ouvert
  sur une paire `*-EUR` est retiré, ce qui n'est pas une cession.
- **Limit post-only, mid + 0,1 % (§7).** Le signe de la marge est la moitié utile
  du post-only : une vente sous le mid croiserait le carnet et serait rejetée.
  Le drapeau `postOnly` est du type `true` ; `false` ne compile pas.
- **`client_order_id` déterministe (§7).** Dérivé de `src/core/order-id.ts`,
  jamais recalculé.
- **Plancher de `MIN_LEG_USDC`.** Sous 200 USDC, la ligne devient un **résidu**
  déclaré dans le rapport au lieu d'un ordre que l'exchange refuserait. Une sortie
  qui laisse 12 USDC de poussière est propre ; une sortie qui émet un ordre
  irrecevable ne l'est pas.
- **Aucun `number` flottant sur une grandeur de marché.** Prix, quantités et
  montants sont des `Decimal` marqués. Les seuls `number` du module sont des
  compteurs et des rangs — numéros de phase, `DECALAGE_DE_JAMBE`, `leg_index`,
  nombre d'ordres retirés — comme le noyau tient déjà ses comptes de jours.
  Un solde ou un mid non fini arrête le plan : `Decimal.lt` et
  `Decimal.gt` répondent tous deux `false` sur `NaN`, donc aucun seuil ne mordrait
  et la cession sortirait avec une quantité indéfinie — même piège que le total
  non fini de `portfolio.ts`.

### Le décalage des numéros de jambe

Le `client_order_id` du §7 est `sha256(run_date | asset | side | leg_index)`. Une
sortie lancée le jour d'un rééquilibrage vendrait BTC en `SELL` avec le même
`leg_index` que le run quotidien, **donc sous le même identifiant** : l'exchange
avalerait la seconde au titre du doublon, et le portefeuille resterait à moitié
liquide sans qu'aucune erreur ne remonte. La sortie numérote donc ses jambes à
partir de `DECALAGE_DE_JAMBE` (900).

Ce n'est pas la solution de fond. Celle-ci consiste à donner à la sortie son
propre domaine dans `src/core/order-id.ts`, qui en a déjà un, versionné. Elle
touche `src/core/`, que ce lot n'a pas mandat de modifier. À reprendre au lot qui
y touchera.

### Non appliquées, et pourquoi

`validate()` de `src/core/risk.ts` **n'est pas appelée**, et ne doit pas l'être.
Une liquidation déplace bien plus que les 25 % de `REBALANCE_TOO_LARGE_PCT` et
vide les lignes que `MAX_EXPOSURE` protège : elle serait rejetée à chaque fois.
Ces seuils gouvernent un rééquilibrage, pas un arrêt. Les relâcher pour faire
passer une liquidation aurait donné à la couche risque le mode de contournement
qu'`AGENTS.md` lui interdit ; les contourner en silence aurait été pire. Les
invariants du §7 et du §11 qui s'appliquent vraiment sont repris nommément
ci-dessus.

Ce n'est pas une affirmation de commentaire. `core/risk.ts` est dans la liste
blanche d'imports du module — il y prend `QUOTE` et `MIN_LEG_USDC` — donc rien
n'empêcherait d'en prendre aussi `validate` : V7 refuse nommément ce
spécificateur, renommé compris.

## 5. Points ouverts

**L'ordre des étapes est celui de la spec, et il laisse une fenêtre.** Le §14
désactive le cron en étape 3, après les cessions. Un run quotidien qui tombe
pendant une sortie relirait un portefeuille en cours de liquidation et, en phase
3, y répondrait. Désarmer le déclencheur **en premier** fermerait cette fenêtre.
Ce n'est pas un ajustement technique : c'est une modification du déroulé de la
spec, donc une décision de l'opérateur. L'ordre livré est celui du §14.

**Le rapport est `PROJETE`, jamais `RÉALISÉ`.** Le §14 décrit un rapport final,
donc postérieur aux exécutions. Celui-ci les précède, puisque rien ne s'exécute :
les montants sont ceux du prix limite, attendus et non encaissés. Le type le dit
pour qu'aucun lecteur ne s'y trompe.

**La quantité cédée est le solde total, gelé compris.** C'est correct **parce
que** l'étape 1 précède l'étape 2 : les ordres en vol sont retirés, donc la part
immobilisée redevient disponible. Un exécuteur de phase 3 qui inverserait les
deux étapes émettrait des ordres sur une quantité qu'il ne détient pas encore.

**Les soldes et les ordres ouverts arrivent par deux champs distincts**, donc
rien ne garantit qu'ils ont été lus dans la même passe. C'est la même
non-atomicité que `reconcile.ts` déclare pour ses deux lectures. Un ordre dénoué
entre les deux donne soit une annulation sans objet — sans effet —, soit une
quantité cédée qui ne correspond plus au solde réel : trop grande, l'exchange
refuse l'ordre ; trop petite, il reste une position qu'une seconde passe
reprendrait. En phase 1 la fenêtre est théorique, puisque rien ne s'applique ; en
phase 3, c'est à l'exécuteur de relire avant d'appliquer.

**Les soldes viennent de `reconcile()`.** `SortieInput.soldes` est un
`ReconciledBalances`, que seul `src/jobs/reconcile.ts` sait fabriquer — son
symbole de marque n'est pas exporté. On ne liquide donc pas sur un état composé à
la main, et une réconciliation abandonnée ne rend aucun solde à liquider.
