# Réconciliation

`src/jobs/reconcile.ts` implémente la réconciliation de la spec §7 : **ce que
l'exchange dit, confronté à ce que la base croit**, avant qu'aucune décision ne
soit prise. Ce document dit ce qui est fait, ce qui ne l'est pas, et pourquoi.

Lot Q4a de la phase 1, révisé au lot **Q10** : la divergence ne bloque plus, elle
rafraîchit ; puis aux lots **S8a** et **S8b** de la phase 3 : l'issue de chaque
ordre est lue et persistée, et les ordres d'un run antérieur s'annulent (règle
révisée par [ubac-prix-au-carnet.md](specs/ubac-prix-au-carnet.md), D5). Le run
quotidien qui appelle cette fonction est `src/jobs/daily.ts`.

## 1. Ce que la réconciliation fait

| Étape de la spec §7 | État |
|---|---|
| 1. Lire les soldes réels et les ordres ouverts | fait |
| 2. Mettre à jour les `orders` en `PENDING` selon leur statut réel | fait : lu ici, écrit par `daily.ts` — section 4 |
| 3. Annuler les ordres limit d'un run antérieur, quel que soit leur âge | fait : décidé ici, appliqué par `execute.ts` — section 3 |
| 4. Comparer soldes réels et état interne, agir au-delà de 1 % | fait — section 1 bis |

Le résultat porte les soldes validés, les transitions d'ordres, deux
observations, et un champ `resync` qui dit si l'état interne a dû se rendre.
**Il n'y a pas de branche d'abandon** : la divergence de solde en était le seul
motif, et elle n'abandonne plus.

Rien n'est corrigé *sur l'exchange*, rien n'est rattrapé : ce module ne place, ne
retire ni n'annule quoi que ce soit, et ne persiste rien non plus — il **rend**
les lignes d'`orders` à écrire et les ordres à annuler, et c'est le run qui écrit
et `execute.ts` qui annule. Ce qui se rend
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

## 2 bis. Le cache inclut nos propres exécutions

### Ce qui s'est passé en réel

Le rapport du 2026-10-02 a déclaré `ETAT_RESYNCHRONISE` : BTC +14 %, ETH +13 %,
USDC −24 %, « le portefeuille a bougé hors du système ». C'était faux. La veille,
le rééquilibrage avait acheté environ 0,0047 BTC et 0,100 ETH contre environ
659 USDC, et rien d'autre n'avait bougé.

### Pourquoi

La photo du jour est calculée à l'étape 4bis, sur les soldes que la
réconciliation vient de lire, donc **avant** que l'étape 6 place quoi que ce
soit. Elle ne contient jamais les exécutions des ordres qu'elle précède. Le
lendemain, comparer les soldes réels à cette photo brute faisait de chaque
exécution un mouvement extérieur : l'alerte sonnait après chaque jour
d'exécution et ne distinguait plus un vrai mouvement extérieur.

### Ce qui se passe maintenant

L'état interne comparé est **la photo précédente plus ce que nos ordres ont
exécuté depuis**. Pour chaque ordre ouvert en base dont l'exchange a rendu un
statut lisible (section 4), la part nouvelle est la différence entre ce que
l'exchange dit maintenant et ce que la dernière transition écrite avait déjà
constaté (`orders.filled_qty`, `filled_price`, `fees`) :

- achat : l'actif monte de la quantité nouvelle ; l'USDC baisse de la valeur
  nouvelle (quantité × prix moyen) et des frais nouveaux ;
- vente : l'actif baisse ; l'USDC monte de la valeur nouvelle, frais nouveaux
  déduits.

Un partiel sur deux runs ne compte donc qu'une fois. Le seuil et la comparaison
ligne à ligne (section 2) ne changent pas, et seul l'écart restant déclenche la
resynchronisation.

### Ce que cela ne couvre pas

- **Un ordre `INDETERMINABLE` n'apporte rien** : son exécution ne se devine
  pas, et l'écart qu'il laisse doit rester visible.
- **Les `cash_flows` ne sont pas ajoutés.** Un apport saisi à la main peut
  dater d'avant ou d'après la photo qui le contient déjà ; l'ajouter
  risquerait de le compter deux fois. Un apport reste donc un mouvement
  extérieur déclaré, ce qu'il est.
- **Les lectures de l'exchange ne sont pas atomiques.** Une exécution entre la
  lecture des soldes et celle du statut se retrouve dans la part de l'un des
  deux runs. L'écart est borné par une exécution partielle, et le seuil de 1 %
  l'absorbe en pratique.

## 3. L'annulation des ordres d'un run antérieur, et le garde de l'étape 6 (S8b)

**La règle ([ubac-prix-au-carnet.md](specs/ubac-prix-au-carnet.md), D5).** Tout
ordre encore ouvert — rien d'exécuté, ou une partie : « non exécuté » veut dire
« pas entièrement » — dont le `run_date` est **antérieur** au `run_date` du run
en cours est rendu à annuler, **quel que soit son âge**. Un ordre du même
`run_date` — second run du jour — n'est jamais annulé.

La règle compare des **jours**, jamais des instants. Le `run_date` d'un ordre est
celui de sa décision, que `pendingOrders()` lit par jointure sur `decisions`. Une
ligne sans décision rattachée prend pour jour celui, en UTC, de son
`orders.created_at`, que le run écrit avec son instant `--at` : le même jour que
son `run_date` aurait porté (ajustement technique 1 du plan). Jamais le
`created_time` de l'exchange : une autre horloge.

**Pourquoi la règle des 24 h a disparu (K4).** Le job démarre entre 05 h 01 et
05 h 08 UTC selon les jours. Un run parti plus tôt que la veille trouvait des
ordres de 23 h 5x, ne les annulait pas, et l'étape 6 ne plaçait rien par-dessus :
le rééquilibrage ne repartait qu'un jour sur deux. Comparer des jours supprime la
dépendance à l'heure de démarrage.

**La réconciliation décide, `execute.ts` applique (T4).** `reconcile()` rend des
`CancellationIntent` et reste une fonction de lecture ; l'appel d'écriture
appartient au seul `execute.ts` (E11, A23), comme les cessions de la sortie.
L'étape 2ter de `daily.ts` les passe à `annuler`, **avant toute décision**.

**Une issue par ordre, et « déjà dénoué » est un succès (E36).** L'annulation part
en un seul envoi et rend `ANNULE`, `DEJA_DENOUE` ou `ECHEC` pour chaque ordre, sans
replier le lot sur un booléen. Un refus de l'exchange ne dit pas lui-même s'il est
bénin : `failure_reason` est une énumération que l'API élargit, et le deviner sur
son texte ferait passer une vraie panne pour de l'idempotence. **Le statut de
l'ordre, relu, tranche** : dénoué, le refus était sans objet ; encore ouvert ou
illisible, c'est un échec. Annuler deux fois le même ordre rend donc `ANNULE` puis
`DEJA_DENOUE`. Un envoi qui lève rend chaque ordre en `ECHEC` sans faire tomber
le run. Rien d'une annulation n'est écrit en base : le run suivant lit l'issue
réelle de l'ordre, quantité exécutée comprise, et la persiste (section 4).

**L'annulation ne suffit pas à empêcher l'empilement, et c'est pourquoi un garde
existe.** Une annulation peut échouer : l'ordre reste ouvert, l'USDC qu'il gèle
compte encore comme détenu, le portefeuille reste hors bande, et une seconde paire
partirait par-dessus la première. Chaque run est plafonné à 8 % ; la somme des
jours ne l'est pas.

**D'où la propriété tenue par `daily.ts` : aucun run ne place d'ordre tant qu'un
ordre d'un run précédent est encore ouvert.** Les ordres « en vol » sont ceux que
la réconciliation a vus ouverts, moins ceux que l'annulation a fermés. S'il en
reste un, l'étape 6 ne place rien, et le refus **s'écrit** : un marqueur
`ORDRES_EN_VOL` en tête de la `reason` de la production, avec les identifiants,
et une ligne de journal. Les trois ombres ne sont pas marquées : elles ne placent
jamais rien. Le run conclut, écrit ses décisions et sa photo, rapporte et pingue.

Ce garde ne change pas avec la règle : une annulation qui échoue retient l'étape 6
tant que l'ordre reste ouvert, et le run réessaie le lendemain. Un ordre posé par
un run vit donc jusqu'au run du jour suivant, quelle que soit l'heure de départ.

**En `DRY_RUN`**, l'annulation passe par le port journalisant : elle est dite,
elle n'atteint pas l'exchange.

**L'horloge est un paramètre de `ReconcileInput`** : `now`, l'instant `--at` du
run, qui date le dénouement, et `runDate`, son jour, qui décide de l'annulation —
jamais une lecture. `src/jobs/` étant hors du glob de pureté
d'`eslint.config.js`, l'interdit tient par un garde-fou de `test/jobs/` : ni
`Date.now()`, ni `new Date()` sans argument, ni `Math.random()`, ni
`crypto.randomUUID()`, ni `performance.now()` dans aucun module de `src/jobs/`
(A7). Des sondes de `test/jobs/reconcile.test.ts` vérifient qu'un autre instant
injecté donne une autre date de dénouement, et qu'un autre jour de run donne une
autre décision d'annulation.

## 3 bis. Ce qu'un exécuteur devra faire du marqueur — **à trancher avant la phase 3**

En phase 1 rien ne s'exécute, donc rafraîchir le cache est sans danger : le pire
qui puisse arriver est une décision journalisée sur un portefeuille qu'un humain
venait de modifier, ce qui est exactement ce qu'on veut savoir.

**En phase 3, ce ne sera plus vrai.** Une divergence constatée juste avant de
passer des ordres est précisément le signal qu'il ne faut pas ignorer : elle peut
signifier qu'un ordre précédent a eu un sort qu'on ignore — exécuté, partiel,
annulé — que la réconciliation lit désormais (section 4) sans que le cache en
tienne compte. Rafraîchir le cache et placer des ordres dans la foulée reviendrait à
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
   s'appuie sur la lecture de la section 4, branchée en S8a, et distingue « un humain a bougé
   le portefeuille » de « un de nos ordres s'est dénoué sans qu'on le sache ».
3. **Exécuter quand même**, la divergence étant par hypothèse déjà réconciliée
   sur les soldes réels. À écrire ici seulement si elle est explicitement
   choisie, jamais par omission.

**Échéance : avant la phase 3**, c'est-à-dire avant que la moindre ligne de
placement n'existe. Tant que rien ne s'exécute, l'absence de décision ne coûte
rien ; le jour où l'étape 6 est écrite, elle coûte la question entière.

## 4. Le statut réel de chaque ordre : lu en S2, branché et persisté en S8a

**Ce qui est lu.** Pour chaque ligne ouverte d'`orders` — `PENDING` ou
`PARTIAL`, les deux états ouverts du §4 —, la réconciliation lit le statut que
l'exchange donne de **cet** ordre, `orderStatus` (`docs/coinbase-lecture.md`
§10), par son `exchange_id` ou, pour la ligne dont le placement n'a pas été écrit,
par celui de la liste des ordres ouverts. Elle rend :

```ts
type ReconciledOrderStatus =
  | { kind: 'PENDING'; exchangeId }                 // ouvert, rien d'exécuté
  | { kind: 'PARTIAL'; exchangeId; filled }         // ouvert, en partie exécuté
  | { kind: 'SETTLED'; outcome; filled }            // FILLED, CANCELLED, EXPIRED, FAILED
  | { kind: 'INDETERMINABLE'; reason };             // l'aveu, section suivante
```

**`INDETERMINABLE` cesse d'être atteignable pour un ordre que l'exchange
connaît** (E37). Il reste, et doit rester, dans trois cas : une ligne sans
`exchange_id` absente des ordres ouverts — l'exchange ne se consulte que par
l'identifiant qu'il donne, et un placement jamais confirmé (E23) n'en a pas ; une
lecture qui échoue ou rend un statut que l'adapter ne sait pas interpréter ; un
identifiant que l'exchange rattache à un autre `client_order_id`. Une lecture en
échec sur un ordre que la liste des ordres ouverts porte garde la vue de cette
liste. Dans aucun de ces cas la réconciliation ne lève : un ordre illisible ne
condamne pas les runs suivants.

**Ce qui est écrit (E38).** Chaque statut lu rend la ligne à reporter —
`status`, `filled_qty`, `filled_price`, `fees`, `settled_at`, et l'`exchange_id`
qui manquait —, et l'étape 2bis de `daily.ts` l'écrit par `recordTransition`,
avant toute décision. `FILLED` s'écrit `FILLED`, `FAILED` s'écrit `REJECTED`, et
`EXPIRED` s'écrit `CANCELLED` : le §4 n'a pas de sixième valeur, un ordre
`limit_limit_gtc` n'expire pas, et les deux issues laissent le même solde — la
quantité exécutée, conservée, est ce qui compte. Un ordre partiellement exécuté
puis annulé s'écrit donc `CANCELLED` **avec** sa quantité.

**Persister est un affinement, pas une réécriture.** Deux moitiés :

- **côté calcul**, un `INDETERMINABLE` ne rend aucune ligne à écrire, donc
  n'efface rien ;
- **côté base**, la requête elle-même refuse de réécrire une issue
  (`status` doit être `PENDING` ou `PARTIAL`) et de faire reculer `filled_qty`,
  et ne remplace pas un `exchange_id` déjà posé. Aucune lecture préalable :
  même raisonnement que l'index unique de `decisions`. Une transition refusée
  rend `UNCHANGED`, qui n'est pas une erreur.

**`settled_at` est l'instant du run qui constate l'issue**, pas celui où
l'exchange l'a prononcée : une borne supérieure, en retard d'un run au plus.
L'instant exact de chaque exécution reste lisible par `orderFills` tant que
l'`exchange_id` est en base ; c'est ce que l'export du PRU (§11, hors
périmètre) devra lire.

**Ce que la persistance ne ferme pas.** Une ligne sans `exchange_id` dont
l'ordre a été accepté puis s'est dénoué avant le run suivant — le job mort
entre le placement et l'écriture de son issue — reste `INDETERMINABLE` : il
faudrait une lecture par `client_order_id`, que l'adapter n'a pas.

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
  seule ; le type dit exactement ce qu'elle touche. Les transitions d'ordres
  qu'elle rend sont écrites par `daily.ts`.
- **Le lendemain d'une exécution, le cache ment, et la réconciliation le prend
  pour un mouvement hors système.** La photo porte les soldes lus **avant** le
  placement de l'étape 6. Si des ordres s'exécutent avant le run suivant, les
  soldes réels s'écartent de la photo de la taille du rééquilibrage — bien
  au-delà de 1 % —, le run se resynchronise et pousse `RECONCILIATION_DRIFT` en
  `URGENT`, avec un texte qui dit « le portefeuille a bougé hors du système »
  alors que rien d'anormal ne s'est passé. **S8a ne le ferme pas** : il pose les
  données qui permettraient de l'expliquer — `filled_qty`, `filled_price` et
  `fees` par ordre —, pas le calcul. Le fermer demande de comparer les soldes à
  la photo **plus l'effet des exécutions connues depuis**, au même seuil et avec
  la même formule d'écart ; c'est la référence de comparaison qui change, donc
  une décision sur la lecture d'E39, à prendre avant S13 — qui ferait refuser
  d'exécuter chaque lendemain d'exécution.
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
