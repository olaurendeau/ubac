# Réconciliation

`src/jobs/reconcile.ts` implémente la réconciliation de la spec §7 : **ce que
l'exchange dit, confronté à ce que la base croit**, avant qu'aucune décision ne
soit prise. Ce document dit ce qui est fait, ce qui ne l'est pas, et pourquoi.

Lot Q4a de la phase 1. Le run quotidien qui appelle cette fonction est le lot
Q4b et n'est pas écrit ici.

## 1. Ce que la réconciliation fait

| Étape de la spec §7 | État |
|---|---|
| 1. Lire les soldes réels et les ordres ouverts | fait |
| 2. Mettre à jour les `orders` en `PENDING` selon leur statut réel | **calculé, non persisté** — section 4 |
| 3. Annuler les ordres limit de plus de 24 h | **reporté en phase 3** — section 3 |
| 4. Comparer soldes réels et état interne, abandonner au-delà de 1 % | fait |

Le résultat est une union : soit `RECONCILED`, qui porte les soldes validés, les
transitions d'ordres et deux observations ; soit `ABORTED`, qui porte le motif et
les lignes divergentes, **et aucun solde**.

Rien n'est corrigé, rien n'est rattrapé. L'état de l'exchange fait foi et l'état
interne n'est qu'un cache : au-delà du seuil, le run est abandonné et un humain
regarde. Un rattrapage automatique sur un cache dont on vient de constater qu'il
est faux est la façon la plus directe de transformer un écart constaté en perte
réelle.

## 2. Le seuil de 1 % se compare ligne à ligne

La spec écrit « divergence entre soldes réels et état interne » sans dire si la
comparaison porte sur la valeur totale ou sur chaque ligne. Le choix retenu est
**ligne à ligne, sur les quantités**, avec l'écart relatif

    drift(actif) = |réel − interne| / max(|réel|, |interne|)

et un seuil **strict** : 1 % pile passe, 1,01 % abandonne. Trois raisons, dans
l'ordre où elles pèsent.

**a. Le noyau fixe déjà cette sémantique.** `src/core/risk.ts` porte depuis la
phase 0 le rejet `RECONCILIATION_DRIFT`, calculé exactement ainsi sur
`RiskContext.balances`, couvert à 100 %. Deux définitions concurrentes de
« divergence de 1 % » dans le même programme est le défaut, pas le raffinement :
le job abandonnerait là où la couche risque accepte, ou l'inverse. La fonction du
noyau n'est pas exportée et la phase 1 n'a pas le droit de toucher à `core/`,
donc le calcul est **recopié** — même choix, et même motif, que le `DECIMAL_TEXT`
recopié entre `config/env.ts`, `adapters/schema.ts` et `adapters/coinbase.ts`.
La copie est verrouillée par `test/jobs/reconcile-accord-risque.test.ts`, qui
exige que les deux rendent le même verdict sur la même table de cas.

**b. Ligne à ligne voit la divergence compensée ; la valeur totale ne la voit
pas.** Un cache qui dit 1 BTC et 20 ETH face à un exchange qui porte 1,02 BTC et
19,6 ETH vaut, à 60 000 et 3 000, exactement la même chose des deux côtés : la
valeur totale ne bouge pas d'un centime. Deux erreurs qui s'annulent en valeur,
c'est la forme même d'un échange mal enregistré. Ligne à ligne, BTC dérive de
1,96 % et ETH de 2 % : le run est abandonné. `test/jobs/reconcile.test.ts` fige
ce cas, et vérifie d'abord que les deux totaux sont bien égaux — sans quoi le
test ne prouverait rien.

**c. Ligne à ligne n'a besoin d'aucun prix.** Comparer des valeurs totales
exigerait les prix de marché, donc une seconde source externe avec ses propres
pannes. Le garde-fou de réconciliation échouerait alors pour des raisons
étrangères à la réconciliation. Les quantités se comparent seules.

**Ce que le contrôle par valeur totale aurait ajouté : rien d'utile.** Si chaque
ligne est dans les 1 %, alors pour chaque actif `min ≥ 0,99 × max`, donc
`Σ max ≤ Σ min / 0,99 ≤ max(total) / 0,99`, et l'écart sur la valeur totale est
borné par `0,01 / 0,99 ≈ 1,0102 %`. Le contrôle global ajouterait donc au mieux
un centième de point de sensibilité, au prix d'une dépendance aux prix. La
réciproque est fausse, et c'est le point b.

**La comparaison porte sur l'union des deux côtés**, pas sur les seules devises
présentes sur le compte : une ligne que le cache porte et que l'exchange ne porte
plus est exactement la divergence que la réconciliation existe pour voir. Une
ligne absente d'un côté vaut zéro, donc dérive de 100 % face à un solde non nul.
Deux zéros ne divergent pas — le portefeuille réel porte un compte EUR à zéro,
capturé en fixture au lot Q3.

Les soldes comparés sont `available + hold` : le gelé d'un ordre ouvert reste
détenu, l'exclure ferait baisser la valeur du portefeuille à chaque ordre en vol.

## 3. L'annulation des ordres de plus de 24 h est reportée en phase 3

L'étape 3 du §7 — « annuler tout ordre limit non exécuté datant de plus de 24 h »
— **n'est pas implémentée, même désarmée**. C'est une décision de l'opérateur
(D2), pas un oubli.

- En phase 1 aucun ordre n'est jamais placé, donc aucun ordre ne peut avoir plus
  de 24 h. La branche serait du code mort, non testable sur des données réelles.
- Écrire un appel d'annulation contredirait le garde-fou de phase : le lint
  d'`eslint.config.js` refuse dans `src/adapters/` et `src/jobs/` tout nom qui
  dénote un placement, une annulation ou un retrait.
- La clé Coinbase est en lecture seule, donc le chemin ne serait de toute façon
  pas testable de bout en bout.

Conséquence directe : **la réconciliation n'a pas d'horloge**. Ni système, ni
injectée — aucune de ses décisions ne dépend du temps, et une horloge injectée
qui ne sert à rien est un paramètre que le prochain lecteur croira utile. Le jour
où l'étape 3 arrive, l'horloge devient un paramètre de `ReconcileInput` ; elle ne
se lit pas dans le module. `src/jobs/` étant hors du glob de pureté
d'`eslint.config.js`, l'interdit tient par un garde-fou de `test/jobs/` : ni
`Date.now()`, ni `new Date()` sans argument, ni `Math.random()`, ni
`crypto.randomUUID()`, ni `performance.now()` dans aucun module de `src/jobs/`.

## 4. Une lecture manque à l'adapter, et c'est un prérequis de la phase 3

L'étape 2 du §7 est **calculée mais pas persistée**. La raison n'est pas
l'écriture manquante ; elle est plus profonde.

`CoinbaseReader` n'expose que les ordres **ouverts**. Un ordre `PENDING` que la
base connaît et que cette liste ne contient pas s'est dénoué — exécuté, annulé ou
rejeté — et **rien dans ce que le dépôt sait lire ne dit lequel**. Distinguer les
trois issues demande le statut réel d'un ordre donné, ou ses exécutions ; pas la
liste des ordres ouverts.

Ce n'est pas une limite de la clé en lecture seule, et la phase 3 ne la lèvera
pas en gagnant `can_trade` : **c'est une lecture qui manque à l'adapter**. Elle
doit être comblée avant la phase 3, faute de quoi un ordre partiellement exécuté
resterait `PENDING` pour toujours dans la base.

En attendant, le statut rendu le dit :

```ts
type ReconciledOrderStatus =
  | { kind: 'PENDING' }                           // ouvert, rien d'exécuté
  | { kind: 'PARTIAL'; filled: Quantity }         // ouvert, partiellement exécuté
  | { kind: 'INDETERMINABLE'; reason: string };   // dénoué, issue inconnue
```

`INDETERMINABLE` n'est pas une valeur de la colonne `status` du §4 : c'est
l'aveu que la question n'a pas de réponse avec les données disponibles. Le
replier sur `CANCELLED` par défaut classerait un ordre exécuté en annulé, ce qui
est pire que de ne pas le classer. L'union force l'appelant à traiter le cas ;
supprimer le traitement explicite de l'absence ne laisse pas passer une valeur
par défaut, cela ne compile plus.

En phase 1 la table `orders` est vide par construction, donc ce chemin ne
s'exécutera jamais en production avant la phase 3. Il est néanmoins testé sur des
données fabriquées, pas supposé.

`src/adapters/db.ts` n'a **pas** été étendu d'une écriture de statut : ajouter
une écriture pour un statut que personne ne sait encore déterminer déplacerait le
même piège une couche plus bas.

## 5. La réconciliation précède toute décision

Un run qui déciderait d'abord et réconcilierait ensuite lirait un état périmé.
La propriété est tenue par deux moitiés, aucune n'étant une consigne.

**Par le type.** Les soldes validés sortent dans un `ReconciledBalances` marqué
par un symbole que `reconcile.ts` n'exporte pas. Hors du module, aucun littéral
d'objet ne peut nommer la propriété : il faudrait une assertion
`as unknown as`, qui se voit en revue. Et le champ `holdings` n'existe que sur la
branche `RECONCILED` — la branche `ABORTED` n'en porte pas. Un run ne peut donc
pas obtenir de soldes sans réconcilier, ni décider sur un abandon. Des assertions
de types de `test/jobs/` figent ces quatre impossibilités.

**Par un garde-fou.** Restait le contournement : appeler soi-même
`exchange.balances()` et se fabriquer un `Holdings` à la main. Un garde-fou de
`test/jobs/` réserve tout appel `.balances()` à `reconcile.ts`. Le contrôle est
vide aujourd'hui — `reconcile.ts` est le seul job livré — et devient un verrou au
premier module de Q4b, comme le lint de `src/adapters/**` posé en Q1.

L'ordre des lectures est lui-même testé : soldes, ordres ouverts, ordres en
attente, dernier snapshot.

## 6. Ce que la réconciliation ne fait pas, et les limites assumées

- **Elle ne persiste rien.** Les deux dépendances sont des `Pick` de lecture
  seule ; le type dit exactement ce qu'elle touche.
- **Un premier run n'a pas de cache.** Sans snapshot, il n'y a rien à comparer :
  le résultat le dit (`comparedTo: 'NO_INTERNAL_STATE'`) plutôt que d'afficher
  une réconciliation qui n'a rien réconcilié. Une absence de comparaison n'est
  pas une divergence nulle.
- **Les `cash_flows` ne sont pas déduits du cache.** Un apport de plus de 1 % de
  la ligne USDC, survenu entre deux runs, fait donc abandonner le run. C'est
  conforme au §7, qui ne donne qu'un motif d'abandon et ne mentionne pas les
  flux, et c'est le sens prudent en phase d'observation : l'agent ne décide pas
  sur un portefeuille qui a bougé sans qu'il le sache. Le coût est réel — les
  runs restent bloqués tant que le cache interne n'a pas été rafraîchi — et c'est
  une décision à réexaminer quand le run quotidien saura écrire son snapshot.
- **Les deux lectures de l'exchange ne sont pas atomiques.** Un ordre peut se
  dénouer entre la lecture des soldes et celle des ordres ouverts. La conséquence
  va toujours dans le sens prudent — soit la ligne apparaît `INDETERMINABLE`,
  soit les soldes divergent du cache et le run est abandonné —, jamais dans celui
  d'un état périmé accepté en silence. En phase 1 la fenêtre est théorique :
  aucun ordre n'est placé.
- **Deux anomalies sont signalées sans abandonner le run** : un ordre ouvert
  qu'aucune ligne `PENDING` ne réclame, et une devise non nulle hors
  BTC / ETH / USDC. Le §7 ne donne qu'un seul motif d'abandon ; ces deux-là sont
  rendues pour que le run les signale (lot Q6).
- **Deux comptes de la même devise sont sommés**, pas réduits au premier trouvé :
  en retenir un seul rendrait un solde faux et plausible.
