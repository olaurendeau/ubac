# Réconciliation

`src/jobs/reconcile.ts` implémente la réconciliation de la spec §7 : **ce que
l'exchange dit, confronté à ce que la base croit**, avant qu'aucune décision ne
soit prise. Ce document dit ce qui est fait, ce qui ne l'est pas, et pourquoi.

Lot Q4a de la phase 1, révisé au lot **Q10** : la divergence ne bloque plus, elle
rafraîchit. Le run quotidien qui appelle cette fonction est `src/jobs/daily.ts`.

## 1. Ce que la réconciliation fait

| Étape de la spec §7 | État |
|---|---|
| 1. Lire les soldes réels et les ordres ouverts | fait |
| 2. Mettre à jour les `orders` en `PENDING` selon leur statut réel | **calculé, non persisté** — section 4 |
| 3. Annuler les ordres limit de plus de 24 h | **reporté en phase 3** — section 3 |
| 4. Comparer soldes réels et état interne, agir au-delà de 1 % | fait — section 1 bis |

Le résultat porte les soldes validés, les transitions d'ordres, deux
observations, et un champ `resync` qui dit si l'état interne a dû se rendre.
**Il n'y a pas de branche d'abandon** : la divergence de solde en était le seul
motif, et elle n'abandonne plus.

Rien n'est corrigé *sur l'exchange*, rien n'est rattrapé : ce module ne place, ne
retire ni n'annule quoi que ce soit, et ne persiste rien non plus. Ce qui se rend
au-delà du seuil, c'est le **cache**.

## 1 bis. Au-delà du seuil, le cache se rend — pas le run

### Ce qui s'est passé en réel

L'opérateur a rééquilibré son portefeuille **à la main**, hors du système. Les
quantités ont donc changé entre deux runs :

| Ligne | Avant | Après | Écart |
|---|---|---|---|
| BTC | 0,0159 | 0,0284 | 44 % |
| ETH | 0,5155 | 0,6729 | 23 % |
| USDC | 2 946 | 1 620 | 45 % |

Le run suivant a comparé l'exchange à la dernière photo, trouvé trois écarts
au-delà de 1 %, et **abandonné avant toute écriture** — donc sans poser de
nouvelle photo. Le run d'après a relu la **même** photo périmée et abandonné de
nouveau. Chaque jour, pour toujours : une intervention manuelle condamnait le
job, sans aucun chemin de retour.

### Pourquoi l'abandon était la mauvaise réponse

L'impasse contredit le principe que le §7 pose lui-même : « l'état de l'exchange
fait toujours foi ; l'état interne n'est qu'un cache ». Un cache dont on vient de
constater qu'il est faux n'a aucune autorité pour geler le système. Le
raisonnement d'origine — « un rattrapage automatique sur un cache faux transforme
un écart constaté en perte réelle » — visait un rattrapage qui aurait **agi sur
l'exchange**. Ce n'est pas ce qui se passe ici : rien n'est acheté, vendu ni
annulé. Le run se contente de décider sur les soldes réels, qui étaient déjà les
seuls qu'il ait jamais utilisés.

### Ce qui se passe maintenant

**Décision de l'opérateur (D7).** Au-delà du seuil, la réconciliation rend
`resync: RESYNCHRONIZED` et le run continue :

1. il décide sur les soldes de l'**exchange**, qui font foi ;
2. l'étape 7 repose une photo aux quantités réelles — c'est **là** que le cache
   se rafraîchit, `reconcile.ts` n'écrivant toujours rien ;
3. le jour est **marqué**, de deux façons qui ne dépendent pas l'une de l'autre.

Le seuil de 1 % et sa comparaison ligne à ligne n'ont pas changé, ni le calcul de
l'écart : seule la **conséquence** d'un dépassement a changé.

### Les deux marques, et pourquoi il en faut deux

**Une alerte**, `RECONCILIATION_DRIFT`, priorité `URGENT` — l'entrée que le §9
prévoyait déjà pour la divergence, dont le déclencheur change sans que le
catalogue bouge. Une resynchronisation silencieuse serait pire que l'impasse
qu'elle remplace : le run conclurait normalement, la base porterait de nouveaux
soldes, et personne ne saurait que le portefeuille a bougé hors du système.

**Un marqueur durable**, `ETAT_RESYNCHRONISE`, en tête de `decisions.reason` des
**quatre** stratégies du jour. Même forme, et même motif, que le
`SUSPENSION_DRAWDOWN` du §6. L'alerte réveille le jour même ; elle ne se relit pas
six mois plus tard. Le journal des décisions, si : un lecteur doit pouvoir dire,
sans rien d'autre sous la main, que ce jour-là quelqu'un a bougé le portefeuille
hors du système. Les quatre lignes le portent parce que l'état resynchronisé est
celui du **portefeuille**, pas d'une stratégie — et c'est la ligne qu'on ne lit
pas qui mentirait. Le texte est celui de `reconcile.ts`, repris tel quel par
l'alerte et par la base : une seule source, donc jamais deux chiffres différents.

Le marqueur **précède** le motif de la stratégie et ne le remplace pas,
contrairement à la ligne d'un jour suspendu : la décision a bien eu lieu, sur les
soldes réels, et son motif reste lisible.

### Ce que cela ne ferme pas

Si l'étape 7 ne peut pas reposer de photo — second run du même jour
(`ALREADY_SNAPSHOTTED`), ou chaîne d'indice rompue (`NO_CARRIED_INDEX`) —, le
cache reste périmé et le run du lendemain se resynchronisera de nouveau. Ce n'est
plus une impasse : chaque run **conclut**, écrit ses décisions et rend son
rapport. Le coût est une alerte `URGENT` répétée tant que la photo ne peut pas
être posée, ce qui est le bon signal : la chaîne de photos est cassée, et c'est
autre chose que la réconciliation.

## 2. Le seuil de 1 % se compare ligne à ligne

La spec écrit « divergence entre soldes réels et état interne » sans dire si la
comparaison porte sur la valeur totale ou sur chaque ligne. Le choix retenu est
**ligne à ligne, sur les quantités**, avec l'écart relatif

    drift(actif) = |réel − interne| / max(|réel|, |interne|)

et un seuil **strict** : 1 % pile passe, 1,01 % resynchronise. Trois raisons,
dans l'ordre où elles pèsent.

**a. Le noyau fixe déjà cette sémantique.** `src/core/risk.ts` porte depuis la
phase 0 le rejet `RECONCILIATION_DRIFT`, calculé exactement ainsi sur
`RiskContext.balances`, couvert à 100 %. Deux définitions concurrentes de
« divergence de 1 % » dans le même programme est le défaut, pas le raffinement :
le job resynchroniserait là où la couche risque accepte, ou l'inverse. Ce que
chaque couche **fait** du verdict lui appartient — le job rafraîchit son cache,
le noyau rejette — mais le verdict lui-même doit être le même. La fonction du
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
1,96 % et ETH de 2 % : le cache se rend. `test/jobs/reconcile.test.ts` fige ce
cas, et vérifie d'abord que les deux totaux sont bien égaux — sans quoi le test
ne prouverait rien.

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

## 3 bis. Ce qu'un exécuteur devra faire du marqueur — **à trancher avant la phase 3**

En phase 1 rien ne s'exécute, donc rafraîchir le cache est sans danger : le pire
qui puisse arriver est une décision journalisée sur un portefeuille qu'un humain
venait de modifier, ce qui est exactement ce qu'on veut savoir.

**En phase 3, ce ne sera plus vrai.** Une divergence constatée juste avant de
passer des ordres est précisément le signal qu'il ne faut pas ignorer : elle peut
signifier qu'un ordre précédent a eu un sort qu'on ignore — exécuté, partiel,
annulé — et la section 4 ci-dessous dit que le dépôt ne sait pas encore lire
lequel. Rafraîchir le cache et placer des ordres dans la foulée reviendrait à
agir sur un état dont on vient de constater qu'on ne le comprend pas.

**Ce lot ne résout pas ce problème — l'exécution n'existe pas — mais il ne le
referme pas non plus.** Le champ `resync` du résultat est conçu pour ça : un
exécuteur futur le consulte avant de placer quoi que ce soit, et a de quoi
refuser. Concrètement, trois options se présenteront, et l'une devra être
choisie :

1. **Refuser d'exécuter un jour de resynchronisation**, et laisser le run
   journaliser sans placer. La plus simple, et celle vers laquelle penche la
   rédaction actuelle ; elle demande une valeur de `Trigger` ou un code de rejet
   pour le dire dans `decisions`.
2. **Refuser seulement si des ordres `PENDING` sont indéterminables**, ce qui
   suppose la lecture manquante de la section 4 et distingue « un humain a bougé
   le portefeuille » de « un de nos ordres s'est dénoué sans qu'on le sache ».
3. **Exécuter quand même**, la divergence étant par hypothèse déjà réconciliée
   sur les soldes réels. À écrire ici seulement si elle est explicitement
   choisie, jamais par omission.

**Échéance : avant la phase 3**, c'est-à-dire avant que la moindre ligne de
placement n'existe. Tant que rien ne s'exécute, l'absence de décision ne coûte
rien ; le jour où l'étape 6 est écrite, elle coûte la question entière.

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
`as unknown as`, qui se voit en revue. Un run ne peut donc pas obtenir de soldes
sans réconcilier. Des assertions de types de `test/jobs/` figent ces
impossibilités.

La moitié « et la branche `ABORTED` n'en porte pas » a disparu avec la branche
elle-même : depuis Q10, la réconciliation rend toujours des soldes, et ce sont
toujours ceux de l'exchange.

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
  la ligne USDC, survenu entre deux runs, déclenche donc une resynchronisation et
  son alerte. Ce n'est plus un blocage depuis Q10 — le run conclut — mais c'est
  une alerte `URGENT` pour un événement que l'opérateur a lui-même provoqué. Le
  distinguer d'une divergence non expliquée demanderait de rapprocher l'écart de
  la ligne USDC des `cash_flows` de la période ; c'est une amélioration possible,
  pas une correction, et elle n'est pas faite.
- **Les deux lectures de l'exchange ne sont pas atomiques.** Un ordre peut se
  dénouer entre la lecture des soldes et celle des ordres ouverts. La conséquence
  va toujours dans le sens de la vérité de l'exchange — soit la ligne apparaît
  `INDETERMINABLE`, soit les soldes divergent du cache et la divergence est
  déclarée —, jamais dans celui d'un état périmé accepté en silence. En phase 1 la
  fenêtre est théorique : aucun ordre n'est placé.
- **Deux anomalies sont signalées sans interrompre le run** : un ordre ouvert
  qu'aucune ligne `PENDING` ne réclame, et une devise non nulle hors
  BTC / ETH / USDC. Elles sont rendues pour que le run les signale (lot Q6).
- **Deux comptes de la même devise sont sommés**, pas réduits au premier trouvé :
  en retenir un seul rendrait un solde faux et plausible.
