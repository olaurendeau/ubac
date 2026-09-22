# Plan : ubac-phase-3

Spec de référence : [`docs/specs/ubac-phase-3.md`](../specs/ubac-phase-3.md),
**soixante critères E1 à E60**, décisions O1 à O7 closes le 2026-09-20. Plan
établi le 2026-09-20, `main` à `4514aff` ; revu le 2026-09-21 après la fusion
de #47, #48 et #49, `main` à `b4288b1`.

C'est la **première phase à disposer d'une spec dédiée**. Les phases 1 et 2 ont
été planifiées contre des sous-sections de la v2.0, et leurs plans le signalent
tous les deux : les critères de validation des lots tenaient lieu de critères
d'acceptation. Ce plan ne refait pas cette erreur — chaque lot cite les `E` qu'il
couvre, la table de couverture est exhaustive, et aucun code n'est écrit ici.

## État de départ, constaté et non supposé

Mesures du 2026-09-20 sur ce poste : `make ci && make test` → **1 128 tests
passés, 20 ignorés**, 38 fichiers, 16,4 s. `make coverage` → mêmes comptes,
33,1 s, **`risk.ts` à 100 % lignes et branches**, total 92,4 %.

Ce que le dépôt porte déjà, et qu'aucun lot ne refait :

| Acquis | Fichier | Ce qu'il donne à la phase 3 |
|---|---|---|
| Neuf règles, `risk.ts` à 100 % | `src/core/risk.ts` | `REBALANCE_TOO_LARGE_PCT`, `MIN_LEG_USDC`, `armsCooldown`, `cooldownAnchor` — **écrits, testés, couverts** |
| `client_order_id` déterministe | `src/core/order-id.ts` | domaine `ubac.order-id.v1` versionné, encodage préfixé par longueur, valeur figée par un test |
| Lecteur Coinbase | `src/adapters/coinbase.ts` | quatre routes de lecture énumérées par `READ_ROUTES`, `decimalFromApi`, `requireUsdcQuote` |
| Réconciliation et run quotidien | `reconcile.ts`, `daily.ts` | soldes marqués par un symbole non exporté, transitions calculées ; étapes 1 à 5 et 7 à 9, et le §9 en entier |
| Plan de sortie complet | `src/jobs/liquidate.ts` | les quatre étapes du §14 en intentions, verrouillées par le type |
| Table `orders` | `src/adapters/schema.ts` | `client_order_id` en clé primaire, `decision_id`, `filled_qty`, `filled_price`, `fees`, `settled_at` |
| Alerte `REBALANCE_EXECUTED` | `src/jobs/alerts.ts` | au catalogue en `HIGH` ; **jamais émise** |
| Rejet `REBALANCE_TOO_LARGE` + alerte | `risk.ts`, `alerts.ts` | motif lisible, écriture dans `decisions.reason`, alerte — **tout le chemin d'E32 existe** |
| Image, job Scaleway, cron, Neon, updown | phase 1, lot Q9 | la production tourne, **déployée à la main** |

Ce que le dépôt **n'a pas** : aucun `.github/`, `test/ci/` ni
`docs/integration-continue.md` ; aucune route d'écriture, aucun port ni module
d'exécution ; aucune lecture du statut d'un ordre donné ni de ses exécutions ;
aucune écriture dans `orders` ; aucun champ d'action sur `Alert`. Et
`src/jobs/daily.ts` pose **deux** ancres de cooldown à `null` en dur — ligne 479
pour B, ligne 624 pour A ; les plans précédents n'en citaient qu'une.

### Travaux ouverts à rattacher

**#47, #48 et #49** — le lexique du jargon et le graphe du TWR — **ont été
fusionnées le 2026-09-21**. Leur code est un acquis : `daily-report.ts`,
`lexique.ts`, la lecture `SnapshotPoint` de `db.ts` et le champ
`snapshotSeries` du run. S7b étend donc un rapport qui les porte déjà, et S9
écrit dans un `db.ts` qui a gagné une lecture.

**Reste #45** — Q10, la réconciliation rafraîchit le cache, 779+/278−, soit
**1 057 lignes comptées**, au-delà du plafond. Depuis la fusion de #49, elle est
**en conflit** avec `main` sur `test/report/contrat-run.test-d.ts` : les deux
ajoutent un membre à `NonLusAttendus`, et `MemeEnsemble<>` fait échouer `tsc` si
la résolution en oublie un.

**#45 porte O6.** E60 n'a d'objet qu'une fois #45 fusionnée : sans elle, une
divergence au-delà de 1 % abandonne le run avant toute décision, donc aucun jour
de resynchronisation n'existe et rien ne peut exécuter ce jour-là. **S13 la
rattache** au lieu de replanifier la même chose ; si #45 est fusionnée avant le
dispatch de S7, S13 se replie dans S7 et disparaît.

## Ce que la phase 3 suppose livré par la phase 2, et ce qui avance sans elle

**La phase 2 est planifiée, pas construite.** `docs/plans/ubac-phase-2.md` est
fusionné dans `main`, et **aucun de ses lots R1 à R4 et R7 n'est livré**.

| Lot | Dépend de la phase 2 ? | Pourquoi |
|---|---|---|
| **S1, S2, S3, S4, S5, S10** | **non** | code, tests et documentation, vérifiés par `make check` sur le poste |
| **S6** | **oui — R1 à R4** | il écrit dans `.github/workflows/ci.yml` et `test/ci/workflow.test.ts`, que la phase 2 crée |
| **S7 et la suite** | **oui, indirectement** | sans la chaîne, on déploie **à la main** du code qui place des ordres réels |

Six lots sur quatorze, **~4 450 lignes**, avancent donc sans que la phase 2 ait
commencé : près de la moitié, et c'est la réponse à « que fait-on en attendant ».

### La preuve du `DRY_RUN` et le chemin de repli

**B3 et E13 ne demandent pas la même chose, et les confondre bloque la phase.**
B3 exige que le `DRY_RUN` soit « livré et **éprouvé** avant tout ordre réel » :
une exigence de **preuve**. E13 exige un `workflow_dispatch` chez Scaleway : une
exigence d'**ergonomie de rejeu**.

Si S7 attend E13, la phase 3 s'arrête tant que la phase 2 n'est pas livrée —
alors que la preuve est atteignable autrement : lancer **manuellement** le job
Scaleway sur l'image du commit, avec le drapeau, comme `docs/deploiement.md`
décrit déjà de le faire pour tout le reste. Même image, même environnement,
mêmes secrets ; seul le déclencheur diffère. **Ce qui protège, c'est d'avoir vu
le mode tourner en production, pas d'avoir cliqué dans GitHub.** Recommandation :
S7 exige le `DRY_RUN` éprouvé sur l'image déployée, quel qu'en soit le
déclencheur ; E13 reste porté par S6, livrable après. C'est la décision **T1**.

**Ce repli a une condition que personne ne verra venir** : il suppose le chemin
manuel de `docs/deploiement.md`, que **D8 supprime en R7**. Si R7 passe avant S7,
le repli n'existe plus. **Ordre à tenir : R7 après S7, ou D12 = 1.** Le plan de
phase 2 ne pouvait pas le savoir.

## Les conditions d'entrée, en porte et non en lot

E1 à E5 ne sont pas des lots, et **aucun lot qui place un ordre réel ne part
avant qu'elles soient closes**. Elles ne bloquent pas les six lots qui
n'exécutent rien.

| # | Condition | Ce qui la clôt | Bloque |
|---|---|---|---|
| **E1** | R1 à R4 et R7 de la phase 2 fusionnés | la chaîne existe, `test` requis sur `main`, un merge déploie | S6, et S7 par T1 |
| **E2** | PR #45 fusionnée ou fermée | un merge ou une fermeture | S13 seul |
| **E3** | Canal ntfy fermé | `NTFY_TOKEN` porte un jeton ; plus de `NTFY_CANAL_OUVERT_LIGNE` | **S12** — un bouton de liquidation sur un canal que n'importe qui lit ne se livre pas |
| **E4** | Nouvelle clé CDP, `can_view` + `can_trade`, `can_transfer` faux, scopée sur le portefeuille dédié ; **clé de phase 1 révoquée** | `GET /api/v3/brokerage/key_permissions`, rapporté dans Orca | **S1** (bout en bout) et **S7** |
| **E5** | Portefeuille dédié approvisionné, montant non nul | virement interne depuis le *Primary* | **S7** |

**E4 bloque S1 moins fort qu'il n'y paraît** : S1 s'écrit et se teste contre des
fixtures, et n'a besoin de la nouvelle clé que pour le bout en bout. Le
coordinateur peut le dispatcher avant, à condition que le rapport dise laquelle
des deux vérifications a été faite.

**Et une incertitude de la spec se mesure au moment d'E4, elle ne se déduit
pas** : `docs/cle-coinbase.md` a constaté le 2026-09-11 que `/v2/accounts` rend
le compte entier avec une clé scopée. « Une clé qui reçoit `can_trade` voit-elle
aussi les endpoints v2 échapper au scoping **pour les ordres** ? » — mesure à
faire sur la nouvelle clé, rapportée dans Orca.

## Ce que les phases 1 et 2 ont appris, et qui gouverne ces estimations

Les estimations de la phase 1 se sont trompées d'un **facteur 2 à 3**,
systématiquement en sous-estimant, jamais sur le code métier : Q1 ~450 → 1 440,
Q2 ~700 → 1 534, Q3 ~750 → 1 653. L'écart venait de trois postes attachés à une
**frontière externe** : les tests qui figent le comportement d'un tiers, les
fixtures capturées, et la documentation de ce qui **n'est pas** garanti.

**La phase 3 compte quatre frontières externes** : l'API de trading Coinbase, la
base sur des écritures neuves, l'API Scaleway pour le désarmement du
déclencheur, ntfy pour les actions. Elle ajoute une difficulté que ni la phase 1
ni la phase 2 n'ont eue : **une fixture d'ordre exécuté ne peut pas être capturée
avant qu'un ordre existe** (T2).

D'où : **les estimations ci-dessous sont déjà corrigées** — un lot annoncé à 850
est conçu pour qu'un dépassement de 15 % reste sous le plafond ; **chaque lot
porte son point de redécoupe écrit à l'avance** ; et **le découpage est plus fin
que le besoin fonctionnel ne l'exigerait**, ce qui est le prix de la leçon.

### Proportionner l'audit au risque

Règle du 2026-09-14 : tout lot fournit la **preuve par mutation** dans le rapport
du constructeur ; un lot qui touche un secret, de l'argent ou un garde-fou
fournit **en plus** l'audit affirmation / variantes / sondes.

**Treize lots sur quatorze tombent dans la seconde catégorie** — seul **S14**,
purement documentaire, s'en tient à la mutation. Ce n'est pas un durcissement
gratuit : c'est la définition de la phase, qui touche un secret (la clé de
trade), de l'argent (des ordres réels) et un garde-fou (celui que B4 retire).
**La mutation de référence de chaque lot est nommée dans sa fiche** : un lot dont
la mutation passe encore n'a pas de garde-fou, il a un commentaire.

## Convention de livraison

Inchangée : une PR par lot, **1 000 lignes ajoutées + supprimées** au plus, code,
tests et documentation compris ; lockfiles et fichiers générés exclus du compte,
avec volume et validation documentés séparément. `make typecheck` et `make test`
sur chaque lot. Deux exigences propres à cette phase :

- **`make coverage` sur tout lot qui touche `src/core/`**, avec vérification des
  100 % lignes et branches de `risk.ts`. Concernés : **S3**, **S10**.
- **`make test-db` sur tout lot qui touche `src/adapters/db.ts` ou le schéma.**
  Les vingt tests de base sont ignorés hors base et, depuis D2 de la phase 2,
  hors chaîne. L'index unique de `decisions` et la clé primaire d'`orders` sont
  les deux lignes de défense d'E24 : les laisser à `make test` seul reviendrait à
  ne pas les exécuter. Concernés : **S7**, **S8**, **S9**.

**Aucun secret en clair, à aucune étape** : ni dans le dépôt, ni dans un journal,
ni dans un message d'erreur, ni dans une notification ntfy (E52).

## L'ordre est une contrainte de sûreté, pas une préférence

1. **Rien ne place un ordre réel avant que le `DRY_RUN` soit éprouvé** (B3, E12)
   — S5 précède S7 dans `main`, et E12 demande qu'on puisse le vérifier après
   coup. 2. **Ni avant que la clé soit vérifiée contre une valeur attendue**
   (E6) — S1 précède S7. 3. **Le plafond réduit est armé dès le premier run qui
   exécute** (E29) — S3 précède S7. 4. **La sortie ne s'arme qu'après
   l'exécution** (E43 à E49) — S11 suit S7 : une sortie qui s'appliquerait sur un
   chemin jamais éprouvé serait la première écriture réelle du dépôt, et ce
   serait une liquidation.

## Décisions préalables

Six ambiguïtés changeaient le travail d'un lot sans changer le besoin.
**Elles sont tranchées** : l'opérateur a retenu les six recommandations le
2026-09-21, avant tout dispatch concerné. Elles ne se reposent pas.

| # | Décision | Avant | Réponse retenue |
|---|---|---|---|
| **T1** | Preuve du `DRY_RUN` : `workflow_dispatch` (E13) ou run manuel sur l'image déployée ? | S7 | **run manuel accepté**, E13 porté par S6. Sinon la phase 3 attend la phase 2 en entier |
| **T2** | Fixture d'un ordre exécuté : capturée ou fabriquée ? | S2 | **fabriquée et déclarée comme telle**, remplacée par une capture après le premier ordre réel. Une fixture fabriquée qu'on croit capturée est pire que les deux |
| **T3** | `MARGE_LIMITE_PCT` : partagée entre la sortie et l'exécution, ou recopiée ? | S7 | **partagée**. Une seconde définition du mid ± 0,1 % dérive, et le signe est la moitié utile du post-only |
| **T4** | `reconcile.ts` annule-t-elle, ou rend-elle une **intention** d'annulation ? | S8 | **intention**. Elle reste calculatoire, et E11 reste à un seul module d'écriture |
| **T5** | Lesquelles des onze affirmations du verrou survivent, et où ? | S11 | **V8 et V9 survivent** (surface publique énumérée, aucune chaîne de contournement) ; V1 à V7, V10 et V11 partent avec le verrou |
| **T6** | Une seconde alerte pour le refus d'exécuter un jour de resynchronisation ? | S13 | **non**. `RECONCILIATION_DRIFT` part déjà en `URGENT` ; c'est son texte qui doit le dire |

## Lots

Quatorze lots, préfixe **S** — `P`, `Q` et `R` sont pris par les phases 0, 1 et
2. Les numéros ne se recompactent pas : « S7 » doit désigner le même lot dans ce
plan, dans sa PR et dans sa tâche Orca.

### S1 — La clé de phase 3 : le portefeuille attendu, vérifié contre l'API

**Dépend de** : **E4** pour le bout en bout, de rien pour l'écriture.
*Indépendant de la phase 2.* · **Critères** : E6, E8, et la moitié acquise
d'E7. · **Audit** : secret + garde-fou → mutation **+** audit complet. ·
**Diff estimé compté** : **~800 lignes**.
**Fichiers prévus** : `src/config/env.ts`, `src/adapters/coinbase.ts`,
`src/jobs/daily-main.ts`, `test/config/env.test.ts`,
`test/adapters/coinbase.test.ts`,
`test/adapters/fixtures/coinbase-key-permissions.json`, `docs/cle-coinbase.md`,
`docs/deploiement.md` §1.

**Résultat** : le `portfolio_uuid` attendu devient une variable de configuration,
et le run **refuse de démarrer** si `key_permissions` n'en rend pas exactement
cet UUID. Permissions effectives et UUID sont journalisés à chaque run, avant
tout ordre, sans qu'aucun secret n'apparaisse.

**Pourquoi ce lot est le premier.** Le contrôle d'aujourd'hui est
**auto-référentiel** : `balanceFrom` compare `retail_portfolio_id` au
`portfolio_uuid` **rendu par la clé elle-même**. Il prouve que la réponse est
cohérente avec la clé, pas que la clé est scopée sur le bon portefeuille — une
clé créée par erreur sur *Primary*, le portefeuille sélectionné **par défaut**
dans le CDP Portal, passerait **sans rien faire rougir**. En phase 1 la
conséquence est une lecture du portefeuille principal ; en phase 3, c'est un
rééquilibrage complet exécuté dessus. Et depuis B4, la règle ESLint qui tenait
l'autre moitié s'en va : ce contrôle reste **seul en piste**.

**Le contrôle existant ne part pas** (E6 : « il reste, et ce critère s'y
ajoute ») : l'un prouve la cohérence de la réponse, l'autre l'identité du
portefeuille, et le supprimer en le croyant redondant est exactement l'erreur
contre laquelle son commentaire met en garde.

**Validation** : une valeur attendue fausse d'un caractère fait refuser le
démarrage ; permissions et UUID apparaissent au journal ; aucun journal ni
message d'erreur ne contient la clé ni son secret ; `loadConfig` refuse l'absence
de la nouvelle variable. **Mutation** : retirer la comparaison — la suite rougit.
Seconde : remplacer la valeur attendue par celle que rend la clé — le contrôle
redevient auto-référentiel, et **le test qui ne rougit pas alors est le test à
réécrire**.

**Pièges.** (1) **Le compte de variables change, et c'est ce qui casse un
matin** : `docs/deploiement.md` §1 énumère « les dix variables secrètes » et
`loadConfig` refuse un environnement incomplet ; la onzième doit être posée
**chez Scaleway avant le déploiement**, sinon le run du lendemain ne démarre plus
— d'une façon qui ressemblera à une panne de la clé. (2) Un UUID de portefeuille
n'est pas un secret mais il identifie le portefeuille : il vit chez Scaleway et
se rapporte dans Orca, jamais dans un fichier versionné. (3) Le nom de la
variable ne doit pas commencer par `UBAC_RISK_`, qui fait échouer le démarrage
(`docs/phase-1-frontieres.md` §3) ; ce lot ne rouvre pas cette porte.
(4) `permissionsFrom` refuse déjà toute permission inattendue à vrai, la
permission de sortie comprise, **sans la nommer** — parce que le lint en
interdisait le mot. Contrat **revérifié**, pas réécrit ; après S4, c'est le seul
qui reste sur ce point. (5) `keyPermissions()` est mémoïsée, lue une fois par
run : le contrôle se pose là où le run démarre, sous peine de dépendre d'un ordre
d'appel.

**Redécoupe** : **S1a** la variable et la comparaison ; **S1b** la journalisation
et la documentation.

### S2 — La lecture qui manque : le statut d'un ordre et ses exécutions

**Dépend de** : **S1** fusionné (même fichier). *Indépendant de la phase 2.* ·
**Report levé** : `docs/reconciliation.md` §4, prérequis de la phase 3. ·
**Critères** : E37 ; prépare E38 et E40. · **Audit** : frontière externe +
argent → mutation **+** audit complet. · **Diff estimé compté** : **~900
lignes**.
**Fichiers prévus** : `src/adapters/coinbase.ts`,
`test/adapters/coinbase.test.ts`, `test/adapters/fixtures/coinbase-order-*.json`
(neuves), `test/adapters/frontiere-decimal.test.ts`, `docs/coinbase-lecture.md`,
`docs/reconciliation.md` §4.

**Résultat** : `CoinbaseReader` sait lire le **statut réel d'un ordre donné** et
ses exécutions. `INDETERMINABLE` cesse d'être atteignable pour un ordre que
l'exchange connaît.

**Ce lot n'a pas besoin du retrait du garde-fou, et c'est vérifié.** Le sélecteur
`ORDER_WRITE_NAME` est **ancré** aux deux bouts et exige un des onze verbes en
tête : ni `v3PrivateGetBrokerageOrdersHistoricalFills`, ni un `kind` littéral
`'order'` ou `'fills'`, ni une méthode `orderStatus` ne commence par un verbe de
la liste. S2 passe le lint tel qu'il est, et c'est ce qui lui permet de précéder
S4.

**Validation** : les statuts exécuté, annulé, expiré et rejeté sont distingués ;
un ordre partiellement exécuté **puis annulé** conserve sa quantité exécutée ; un
ordre que l'exchange ne connaît pas reste `INDETERMINABLE` ; les frais entrent
par `decimalFromApi`, jamais par une structure unifiée de ccxt.
**Mutation** : replier un statut inconnu sur `CANCELLED` par défaut — la sonde de
l'ordre exécuté doit rougir. C'est le piège que `docs/reconciliation.md` §4
nomme : cela « classerait un ordre exécuté en annulé, ce qui est pire que de ne
pas le classer ».

**Pièges.** (1) **La fixture d'un ordre exécuté ne peut pas être capturée** — il
n'y a aucun ordre dans le portefeuille dédié, et il n'y en aura pas avant S7.
C'est T2 : une fixture fabriquée est acceptable, une fixture fabriquée qu'on
laisse croire capturée ne l'est pas, et `docs/coinbase-lecture.md` porte la
provenance des quatre existantes. (2) **La phase 1 a payé ce poste au prix
fort** : Q3c a passé quatorze tests sur quatorze avec une conversion par
flottant, parce qu'**aucun prix de la capture n'était décimalement sensible** —
les fixtures doivent porter des grandeurs qui distinguent `Decimal` de `number`.
(3) **Un statut et une quantité ne disent pas la même chose** :
Coinbase rend `status` **et** `filled_size`, un ordre `CANCELLED` partiellement
exécuté existe, et réduire à un seul statut perdrait la quantité — celle qui
compte pour le solde. (4) **`INDETERMINABLE` ne disparaît pas du type** : E37 dit « pour un ordre que
l'exchange connaît », et un ordre jamais accepté — cas qu'E23 rend possible —
reste indéterminable.

**Redécoupe** : **S2a** le statut d'un ordre ; **S2b** les exécutions et les
frais. La coupure sépare deux routes et deux jeux de fixtures.

### S3 — Le plafond réduit

**Dépend de** : **rien**. Parallélisable dès la vague 1. · **Décisions** :
O1 = 3, O2 = 3, O3 = 3. · **Critères** : E29, E30, E31, E32 (constaté), E33
(acté sans objet), E34. · **Audit** : argent + garde-fou → mutation **+** audit
complet ; **`make coverage` obligatoire**. · **Diff estimé compté** : **~500
lignes**.
**Fichiers prévus** : `src/core/risk.ts`, `test/core/risk-state.test.ts`,
`test/core/risk-contract.test.ts`, `docs/run-quotidien.md`,
`docs/rapport-quotidien.md`.

**Résultat** : `REBALANCE_TOO_LARGE_PCT` passe de `0.25` à **`0.08`**, avec le
commentaire qui dit que c'est le plafond d'armement de la phase 3 et par quel
geste il se lève (O3 = 3).

**La valeur vient d'une mesure, pas d'un ordre de grandeur.** Le cadrage
écrivait « de l'ordre de 5 % », un chiffre avancé sans données. Le rejeu les a
produites : sur 974 jours, les douze rééquilibrages de production pesaient de
5,0 à 10,7 % du portefeuille, et la bande cash 24–36 % fait qu'un simple retour
à la cible en déplace déjà ~6 %.

| Plafond | Jours refusés | Exécutions sur les 12 |
|---|---|---|
| 5 % | 594 | 3 |
| 7 % | 353 | 6 |
| **8 %** | **166** | **10** |
| 11 % | 0 | 12 *(soit les 25 % actuels)* |

À 5 %, le premier déclenchement réel aurait été refusé, avec une alerte
`URGENT` chaque jour et rien d'armé avant la levée : le mois calendaire d'O4
serait devenu un mois de refus. Un plafond qui refuse tout est sûr, mais il est
indistinguable d'une panne, et il apprend à ignorer les alertes urgentes.
**L'opérateur a retenu 8 % le 2026-09-21** : le plafond mord encore — deux des
douze rééquilibrages passent à la trappe et 166 jours de déclenchement sont
refusés — sans neutraliser la phase qu'il est censé protéger.

**C'est le lot le plus court et le plus facile à sous-estimer.** Les trois
décisions se referment l'une sur l'autre : `REBALANCE_TOO_LARGE` **refuse déjà le
run entier** — c'est une `Rejection` du verdict, pas un écrêtage de jambe —, son
motif s'écrit déjà dans `decisions.reason`, et son alerte existe depuis Q6a2.
**Tout le chemin d'E32 est acquis**, et le lot ne le replanifie pas : il change
une valeur et constate que le chemin mord dessus. Ce qui coûte, c'est ce que la
valeur touche ailleurs.

**Validation** : un run dont les jambes pèsent 9 % du portefeuille est refusé et
ne l'était pas ; un run à 7 % passe ; le motif cite la nouvelle valeur ; l'alerte
part ; `make coverage` tient les 100 % lignes **et branches**.
**Mutation** : remettre `0.25` — les sondes du plafond rougissent. Si elles ne
rougissent pas, elles ne testaient pas le seuil.

**Pièges.** (1) **La retombée sur les tests existants est le vrai volume du
lot** : des cas construits pour passer sous 25 % tombent sous 8 %. Il ne faut
**pas** les « réparer » en retouchant leurs chiffres au hasard — chacun doit
rester le cas qu'il testait. Le remède est d'exprimer le cas relativement au
seuil, pas de recopier une constante dans le test. (2) **Le débordement sur les
ombres** : `validate()` est appelée pour les quatre stratégies, donc les verdicts
de `rebalance_ab`, `ladder` et `dca` — qui ne placent rien — changent aussi.
Davantage de `REBALANCE_TOO_LARGE` dans `decisions`, dans le rapport et dans les
alertes, sans qu'aucun ordre ne soit en cause. E31 porte sur l'**effet**, pas sur
les verdicts prononcés ; **le lot doit le rapporter** pour que l'opérateur ne
lise pas ce bruit comme une panne — et ce bruit a une valeur : il éprouve le
chemin d'E32 **avant** qu'un euro soit en jeu. (3) **La couverture se perd par
soustraction** : abaisser une constante ne crée pas de branche, supprimer un test
« qui ne passe plus » en laisse une non couverte. (4) Le rapport quotidien
affiche les seuils : vérifier qu'aucun texte figé ne dit « 25 % ».
(5) `RiskLimits` **lit** la constante (`maxRebalanceMagnitudePct:
REBALANCE_TOO_LARGE_PCT`) : rien à y changer, et surtout rien à y poser en dur.
(6) **La levée du plafond n'est pas un lot de ce plan** : O3 = 3 en fait un
commit d'une ligne, en PR relue, quand l'opérateur le décide. Le dire évite qu'on
l'attende dans une vague.

### S4 — Le garde-fou retiré, le port d'exécution, et sa surface énumérée

**Dépend de** : **S1** et **S2** fusionnés (mêmes fichiers). *Indépendant de la
phase 2.* · **Décision** : B4. · **Critères** : E9, E10, E11, et la moitié neuve
d'E7. · **Audit** : garde-fou → mutation **+** audit complet. · **Diff estimé
compté** : **~950 lignes**.
**Fichiers prévus** : `eslint.config.js`, `test/structure.test.ts`,
`test/lint/fixtures/bad-order-write.fixture` (**supprimée**),
`test/lint/fixtures/bad-order-write-disabled.fixture` (**supprimée**),
`src/adapters/coinbase.ts`, `src/jobs/execute.ts` (neuf),
`test/adapters/coinbase.test.ts`, `test/jobs/purete.test.ts`,
`docs/phase-1-frontieres.md` §1.

**Résultat** : le dépôt sait **exprimer** un placement et une annulation, dans un
seul module, par une surface énumérée à l'exécution ; la règle de noms disparaît
**le même jour**, avec ses fixtures et son bloc de test.

**Ce que le dépôt perd ce jour-là**, à écrire dans §1 plutôt qu'à laisser
deviner : la propriété que *aucun module de `src/adapters/**` et `src/jobs/**` ne
prononce un verbe d'écriture d'ordre, ou il rougit*. Elle attrapait l'erreur qui
compte ici — un placement écrit **ailleurs** que dans le module prévu — et rien
d'autre ne la tient. Ce qui la remplace est une **énumération positive** : E10 et
E11, plus E6 à E8 livrés en S1.

**Un constat que le cadrage n'a pas fait, et qui va dans §1 au moment du
retrait** : le sélecteur est **ancré**, et `v3PrivatePostBrokerageOrders` ne
commence par aucun des onze verbes — **la règle n'aurait pas attrapé l'appel
ccxt**. Ce qu'elle interdisait, c'était de **nommer honnêtement** le port.
§1 écrivait déjà « un client HTTP générique » dans ce qu'elle ne garantit pas,
sans tirer la conséquence : **la règle rendait le contournement plus lisible que
le chemin droit**. C'est l'argument le plus fort en faveur de son retrait, et
c'est le jour de l'écrire.

**Validation** : la règle a disparu d'`eslint.config.js` ; les deux fixtures et
le bloc « C32 (phase 1) » ont disparu **ensemble** ; un test énumère la liste
exacte des routes d'écriture **et** des méthodes du port, et en ajouter une fait
rougir la suite ; un garde-fou de `test/jobs/` réserve l'appel des routes
d'écriture à un seul module, et **ce module y figure** ; construire l'exécuteur
avec `can_trade` faux lève. **Mutation** : ajouter une route sans toucher au test
d'énumération — la suite rougit. Seconde : appeler une route d'écriture depuis un
second module de `src/jobs/` — le garde-fou rougit.

**Pièges.** (1) **`noInlineConfig` part avec le bloc, et ce n'est pas ce que B4
décide** : le bloc `ADAPTERS_AND_JOBS` porte `linterOptions: { noInlineConfig:
true }` **en plus** de la règle, et le supprimer en entier rend `eslint-disable`
de nouveau utilisable dans `src/adapters/**` et `src/jobs/**` pour **toutes** les
règles, frontières de couche comprises. **Garder le bloc, n'en retirer que
`no-restricted-syntax`.** C'est le piège le plus coûteux du lot : une suppression
trop large désarme trois garde-fous pour en retirer un. (2) **Les fixtures
servent à plus d'un test** : `bad-order-write` est lue par le bloc C32 **et** par
le test « n'applique pas la règle hors adapters/ et jobs/ ». (3) **Un garde-fou
qui ne désigne personne est vide** : A19 est écrit pour que `reconcile.ts`
**doive** y figurer, « sinon le sélecteur ne désigne rien ». Celui d'E11 a besoin
d'un fichier à désigner — **S4 livre donc `src/jobs/execute.ts`**, avec le port
et sans appelant, plutôt que d'attendre S7. (4) **L'énumération d'E11 devra
grandir** : à la fin de la phase, la sortie place et annule aussi. Soit elle
passe **par** `execute.ts` — la recommandation de T5 —, soit le garde-fou énumère
deux modules, comme A20 a concédé `daily-main.ts` nommément. Le décider ici évite
de le découvrir en revue de S11. (5) **`can_trade` est une condition de
construction, pas un drapeau** : l'exécuteur construit avec `can_trade` faux
**lève**. Aucun paramètre `armed`, aucun mode — E17 interdit qu'une signature
publique porte `dryRun`, `force` ou `bypass`, et l'esprit vaut au-delà de
`risk.ts`. (6) **Le mot de la permission de sortie redevient écrivable** ; après
S4, le refus de toute permission inattendue à vrai est le **seul** contrôle sur
ce point — à redire dans §1. (7) **Rien n'appelle le port à la fin de S4**, et
c'est voulu : le lot livre la capacité, pas l'usage ; B3 n'est pas violé, et E12
reste tenu tant que S5 précède S7 dans `main`.

**Redécoupe** : **S4a** le retrait de la règle, des deux fixtures, du bloc C32 et
la réécriture de §1 ; **S4b** le port, les routes, l'énumération et le garde-fou
de réservation. La coupure laisse une PR entièrement de suppression et une PR
entièrement d'ajout — **mais elle ouvre une fenêtre où le dépôt n'a ni l'ancien
garde-fou ni le nouveau**. Si le coordinateur coupe, S4b suit immédiatement, sans
aucun autre lot entre les deux.

### S5 — Le `DRY_RUN` : le mock qui journalise, au seul point de composition

**Dépend de** : **S4** fusionné. *Indépendant de la phase 2* (voir T1). ·
**Décisions** : B3, D9, D10, D11 — les trois reportées par le plan de phase 2. ·
**Critères** : E12, E14, E15, E16, E17 (constaté). · **Audit** : argent +
garde-fou → mutation **+** audit complet. · **Diff estimé compté** : **~850
lignes**.
**Fichiers prévus** : `src/jobs/daily-main.ts`, `src/adapters/execution.ts`,
`src/adapters/inertes.ts` (neuf), `src/jobs/daily.ts`,
`test/jobs/daily-main.test.ts`, `test/jobs/daily.test.ts`,
`test/jobs/purete.test.ts`, `docs/run-quotidien.md`.

**Résultat** : la même image, lancée avec `DRY_RUN=true`, fait **tout** le run
sauf écrire et sauf envoyer, et journalise ce qu'elle aurait placé —
`client_order_id`, paire, côté, quantité, prix limite, `post_only`.

**E16 est la propriété difficile, et elle demande six substitutions.** Un
`DRY_RUN` n'écrit **rien** : ni `decisions`, ni `snapshots`, ni `orders`, ni
rapport Brevo (D10), ni ping — la photo du jour porte un indice de croissance qui
se **rechaîne sur lui-même**, et le ping dirait à updown.io qu'un run a conclu
alors qu'il n'a pas eu lieu. **La tentation à refuser** : un `if (dryRun)` dans
`daily.ts` devant chaque écriture — exactement ce qu'E15 interdit, et ce qui
ferait de `daily.ts` un module à deux comportements à couvrir deux fois. La forme
qui tient : des **ports inertes**, implémentations du même type, composés à la
place des vrais dans `daily-main.ts`. Aucun module en aval ne sait.

**Validation** : un run complet en `DRY_RUN` n'appelle aucune des trois écritures
ni aucun des trois envois, et la sonde le compte ; le journal porte les six
champs de chaque jambe qui serait partie ; `core/risk.ts` n'expose aucun
paramètre de mode et son test de contrat reste vert ; le mode se lit **une
fois**, au point d'entrée. **Mutation** : rendre un port inerte réellement
écrivant — la sonde de comptage rougit. Seconde : déplacer la condition de mode
dans `daily.ts` — le garde-fou de composition rougit.

**Pièges.** (1) **Un `DRY_RUN` doit lire la vraie base.** E16 interdit
d'**écrire**, pas de lire : `latestSnapshot()` et `recentCashFlows()` sont des
lectures, et les couper rendrait un run sur une journée vide, qui ne rejoue rien
et ne prouve rien. **C'est la distinction qui décide si le mode vaut quelque
chose**, et elle doit être écrite, pas déduite. (2) **Un port inerte doit rendre
des réponses plausibles** : `recordDecision` rend un `RecordDecisionOutcome`, et
`RECORDED` ou `ALREADY_RECORDED` change ce que le journal affiche et ce que
`reported()` conclut. (3) **A20 et A22 tiennent ensemble** : le point de
composition reste `daily-main.ts`, seul fichier de `src/jobs/` autorisé à
importer un adapter en valeur et seul fichier que rien n'importe. Une seconde
voie ferait tomber A20, qui l'énumère **nommément**. (4) Le drapeau entre par la
ligne de commande, comme `run_date` et `git_sha`, jamais par `process.env` lu au
fond du code : `src/jobs/` n'en lit aucune, et `test/jobs/purete.test.ts` le
tient. (5) **Le mock journalise un `client_order_id` réel**, produit par
`core/order-id.ts` (E21) ; s'il en fabriquait un faux, le mode ne dirait rien de
l'idempotence — la moitié de ce qu'on veut éprouver. (6) **Rien ne prouve qu'un
mode non écrivant n'écrit pas**, sinon une sonde qui compte les appels : c'est le
garde-fou du lot, et aussi sa limite déclarée — il compte ce que les ports
reçoivent, pas ce que le processus fait.

**Redécoupe** : **S5a** les ports inertes et la substitution ; **S5b** le mock
d'exécution qui journalise et sa sonde.

### S6 — Le `workflow_dispatch`, chez Scaleway

**Dépend de** : **phase 2, R1 à R4 fusionnés**, et **S5** fusionné. ·
**Décisions** : D9, D11. · **Critères** : E13. · **Audit** : secret → mutation
**+** audit complet. · **Diff estimé compté** : **~450 lignes**.
**Fichiers prévus** : `.github/workflows/ci.yml`, `test/ci/workflow.test.ts`,
`docs/integration-continue.md`, `docs/run-quotidien.md`.

**Résultat** : un `workflow_dispatch` avec `DRY_RUN=true` déclenche le run **chez
Scaleway** (D11), sur la **même image** que la production, taguée par son SHA.

**Ce lot n'existe pas tant que la phase 2 n'est pas livrée** : il écrit dans deux
fichiers que R1 crée. Il est isolé ici précisément pour que son absence ne bloque
pas S7 — voir T1.

**Validation** : le déclenchement manuel lance un run chez Scaleway et non dans
le runner GitHub ; l'image est celle du SHA, jamais `latest` ; la clé secrète
n'apparaît sous aucune forme dans le journal — **le dépôt est public** ; le
garde-fou de workflow épingle le nom du job. **Mutation** : retirer le passage du
drapeau à une des trois couches — la sonde du journal rougit.

**Pièges.** (1) **Le journal est public** : `--password-stdin` comme
`docs/deploiement.md` §5, et aucun `set -x`. (2) **Un run manuel est un run de
plus dans la journée** et ne doit pas marcher sur celui du cron ; le `run_date`
et l'idempotence de `decisions` protègent le run réel, mais un `DRY_RUN` n'écrit
rien : le journal du job est la seule trace. (3) **Le drapeau traverse trois
couches** — l'entrée du workflow, l'appel `scw`, les arguments du job. Chacune
peut le perdre en silence, et **un `DRY_RUN` perdu est un run réel**. Le journal
dit le mode en première ligne, ou le lot n'est pas fini.

### S7 — L'étape 6 : l'exécution armée

**Dépend de** : **toutes les conditions d'entrée closes** (E1 à E5), **S1**,
**S3**, **S4**, **S5** fusionnés, et **le `DRY_RUN` éprouvé sur l'image
déployée** (T1). · **Critères** : E7 en entier, E18 à E24, E25 (revérifié), E26,
E27, E28. · **Audit** : argent + secret + garde-fou → mutation **+** audit
complet ; **`make test-db` obligatoire**. · **Diff estimé compté** : **~1 000
lignes** — **point de redécoupe à couper avant le dispatch**, pas à garder en
réserve.
**Fichiers prévus** : `src/jobs/execute.ts`, `src/jobs/daily.ts`,
`src/adapters/db.ts`, `src/jobs/alerts.ts`, `src/report/daily-report.ts`,
`test/jobs/execute.test.ts`, `test/jobs/daily.test.ts`,
`test/jobs/alerts.test.ts`, `test/report/daily-report.test.ts`,
`test/adapters/db.test.ts`, `docs/run-quotidien.md`.

**Résultat** : l'étape 6 du §8 place les jambes de la **stratégie active
uniquement**, en limit post-only, à mid ± 0,1 % du côté qui ne croise pas le
carnet, après les avoir écrites en base. **C'est le lot qui engage de l'argent** ;
tous les autres le préparent ou le suivent.

**Validation** : un run où les **quatre** stratégies rendent `ACCEPTED` ne
produit d'ordres que pour `rebalance` ; `post_only: false` ne compile pas ;
`quote: 'EUR'` ne compile pas ; le prix limite est **sous** le mid à l'achat et
**au-dessus** à la vente, et le signe est testé, pas seulement l'écart ; rejouer
le run du même jour ne place aucun second ordre, les deux lignes de défense
sondées **séparément** ; `REBALANCE_EXECUTED` part avec le compte placé et le
compte exécuté ; `max retries = 0` constaté dans la définition déployée.
**Mutation** : inverser le signe de la marge limite — la sonde du côté rougit.
Seconde : placer avant d'écrire — la sonde de l'interruption rougit. Troisième :
retirer le filtre de stratégie — la sonde des quatre verdicts `ACCEPTED` rougit.

**Exigence ajoutée le 2026-09-22, constatée en revue de S1 (#52).** La revue a
relevé que `permissionsFrom` accepte une réponse `key_permissions` dont la
permission de sortie a **purement disparu** : l'absence du champ ne prouve pas
qu'il vaut `false`. Ce n'était pas un défaut de S1 — la moitié acquise d'E7
porte sur une permission **vraie**, et la règle `no-restricted-syntax`
interdisait alors de nommer le champ dans `src/adapters/**`, ce qui rendait le
contrôle littéralement inécrivable.

S4 retire cette règle. **S7 doit donc exiger la présence du champ, et pas
seulement sa fausseté** : une réponse où il manque se refuse, avec son test.
C'est exactement la garantie que le retrait du garde-fou (B4) déplace sur la
clé : la spec §7 promet « jamais de permission de retrait », et une promesse
qu'on ne peut pas constater n'en est pas une.

**Pièges.** (1) **E23 laisse une fenêtre, et c'est voulu** : entre `recordOrder`
et le placement il y a un `await`, et le job peut mourir là. Une ligne `PENDING`
sans ordre est rattrapable, un ordre sans ligne ne l'est pas — mais la ligne d'un
ordre **jamais placé** doit être distinguable, sinon la réconciliation du
lendemain la lira comme un ordre dénoué d'issue inconnue. **C'est la lecture de
S2 qui répond** ; sans elle, ce piège n'a pas de sortie. (2) **`orders` doit
porter son rattachement au run, et c'est S7 qui le pose** : `orders` n'a pas de
colonne `run_date`, le lien passe par `decision_id` → `decisions.run_date`, et
**S9 en dépend entièrement**. Si S7 écrit `decision_id` à `null`, le cooldown
n'aura aucun moyen de grouper les ordres par run, et S9 devra rouvrir S7. À
vérifier dans la revue de S7, pas dans celle de S9. (3) **Les deux lignes de
défense d'E24 ne sont pas couvertes par la chaîne** : l'index unique de
`decisions` et la clé primaire d'`orders` vivent dans les vingt tests ignorés
hors base, que D2 laisse hors CI. En phase 3 cette idempotence protège de
l'**ordre double** ; `make test-db` est une exigence de ce lot. (4) **Le mid
± 0,1 % existe déjà, côté vente, dans `liquidate.ts`** : le recopier ferait une
seconde définition libre de diverger, et le signe est la moitié utile du
post-only (T3). (5) **`alertInputOf` pose `executed: []` à deux endroits** : la
branche `ABORTED` doit **rester** vide, un abandon survenant avant l'étape 6.
(6) **Aucune compensation dans la foulée** (E26) ; `max retries = 0` (E25) est la
seconde moitié, acquise depuis Q9 et protégée par la relecture de R3.
(7) **Post-only n'est pas gratuit** : une jambe qui croiserait le carnet est
**rejetée par l'exchange**, et le §7 refuse d'en faire une erreur — le rejet se
journalise sans faire échouer le run, et un run dont toutes les jambes sont
rejetées est un run qui a conclu. (8) **E28 étend un rapport que #47 et #49
ont déjà réécrit** : partir de `main`, pas de la description du plan.

**Redécoupe** : **S7a** le placement, l'écriture en base et l'idempotence (E18 à
E24, E26) ; **S7b** l'alerte et le rapport (E27, E28). S7b touche `alerts.ts`,
que #45 touche aussi : la coupure découple le lot de la seule PR encore en
vol.

### S8 — L'annulation des ordres de plus de 24 h, et les transitions persistées

**Dépend de** : **S2**, **S4**, **S7** fusionnés. · **Report levé** : D2 du plan
de phase 1. · **Critères** : E35, E36, E38, E39 (revérifié). · **Audit** :
argent → mutation **+** audit complet ; **`make test-db` obligatoire**. ·
**Diff estimé compté** : **~850 lignes**.
**Fichiers prévus** : `src/jobs/reconcile.ts`, `src/jobs/execute.ts`,
`src/adapters/db.ts`, `src/jobs/daily.ts`, `test/jobs/reconcile.test.ts`,
`test/jobs/reconcile.test-d.ts`, `test/jobs/reconcile-accord-risque.test.ts`,
`test/adapters/db.test.ts`, `docs/reconciliation.md`.

**Résultat** : tout ordre limit non exécuté de **plus de 24 h est annulé** (§7,
point 3), et les transitions calculées depuis Q4a sont enfin **persistées** dans
`orders` — `status`, `filled_qty`, `filled_price`, `fees`, `settled_at`.

**Validation** : un ordre de 25 h est annulé, un de 23 h ne l'est pas ; annuler
deux fois de suite le même ordre n'est pas une erreur du run ; les cinq colonnes
sont écrites et relues ; `reconcile-accord-risque.test.ts` continue d'exiger que
le job et `core/risk.ts` rendent le même verdict sur la même table de cas.
**Mutation** : classer « ordre déjà dénoué » comme un échec — la sonde de double
annulation rougit.

**Pièges.** (1) **`reconcile()` cesserait d'être une fonction de calcul** :
annuler, c'est écrire sur l'exchange, et E11 réserve les routes d'écriture à un
seul module. Deux issues — `reconcile.ts` rejoint l'énumération, ou elle rend une
**intention d'annulation** que `execute.ts` applique, comme `liquidate.ts` rend
des intentions. C'est T4, et la recommandation est la seconde. (2) **L'horloge
devient un paramètre de `ReconcileInput`** (E35), et c'est un **test** de
`test/jobs/` qui le tient, `src/jobs/` étant hors du glob de pureté
d'`eslint.config.js` : une horloge lue au fond du module passerait le lint et
casserait la sonde. (3) **Les 24 h se comptent sur `created_at`**, qui vient de
la base et que S7 écrit avec l'horloge du run — pas sur `created_time` de
l'exchange. Deux sources, deux fuseaux, et un ordre annulé une heure trop tôt.
(4) **Une annulation en lot rend un échec par ordre** : classer « déjà dénoué »
comme un succès et le reste comme un échec, sans replier les deux sur un booléen
global — sinon une annulation qui échoue pour une vraie raison passe pour
idempotente. (5) **E39 ne bouge pas** : ni le seuil de 1 %, ni la base de
l'écart ; si **#45** est fusionnée, partir de sa version, qui a déjà fait évoluer
ce test de `status` vers `resync`. (6) **Persister une transition, c'est écraser
un état** : un ordre lu `INDETERMINABLE` ne doit pas écraser un `FILLED` déjà
écrit — la persistance est un affinement, pas une réécriture aveugle.

**Redécoupe** : **S8a** la persistance des transitions (E38) ; **S8b**
l'annulation (E35, E36). La coupure sépare une écriture en base d'une écriture
sur l'exchange.

### S9 — Le cooldown alimenté

**Dépend de** : **S2**, **S7**, **S8** fusionnés. · **Critères** : E40, E41,
E42. · **Audit** : garde-fou → mutation **+** audit complet ; **`make test-db`
obligatoire**. · **Diff estimé compté** : **~600 lignes**.
**Fichiers prévus** : `src/adapters/db.ts`, `src/jobs/daily.ts`,
`test/adapters/db.test.ts`, `test/jobs/daily.test.ts`, `docs/run-quotidien.md`.

**Résultat** : `lastCompleteRebalanceOn` vient de la **base**, par
`cooldownAnchor` appliqué à l'historique des exécutions. Le littéral `null` de
`src/jobs/daily.ts` disparaît.

**Ce lot ne touche pas au noyau, et il ne doit pas.** `armsCooldown` et
`cooldownAnchor` sont écrits, testés et **couverts à 100 %** depuis la phase 0 :
la nuance du §7 est implémentée dans le noyau depuis le premier jour. Ce qui
manque est son **alimentation**, pas la règle. Un lot qui rouvrirait `risk.ts`
ici aurait mal lu la spec.

**Validation** : un run partiellement exécuté à J n'empêche pas J+1 de recalculer
et de placer ; un rééquilibrage complet à J bloque J+1 à J+6 et laisse passer
J+7 ; le cooldown de B reste distinct de celui de A (C12), et le gel de 7 jours
après un apport ne gèle pas B (C25, C26). **Mutation** : rendre l'ancre depuis un
run **partiel** — la sonde de bout en bout d'E41 rougit.

**Pièges.** (1) **`cooldownAnchor` raisonne en runs, la base porte des ordres** :
il prend un `RebalanceExecution[]` — `{runDate, ordersPlaced, ordersFilled}` — et
`orders` n'a pas de `run_date`. La traduction passe par `decision_id` →
`decisions.run_date` (piège 2 de S7) et se fait dans `db.ts` ou `daily.ts`,
**jamais** dans le noyau. (2) **Il y a deux `null` en dur, pas un** :
`daily.ts:479` pose `lastRatioRebalanceOn: null` (cooldown de B) et
`daily.ts:624` `lastCompleteRebalanceOn: null` (cooldown de A). **Brancher l'un
en oubliant l'autre est le bug le plus probable du lot.** (3) **L'ancre de B ne
peut pas être alimentée en phase 3, et il faut l'écrire** : le cooldown de B
s'arme sur un arbitrage du déclencheur B, or `rebalance_ab` reste **shadow** et
ne place rien, par périmètre explicite de la spec. Son ancre n'a donc **aucune
source de vérité** dans `orders` ; elle reste `null`, et le commentaire doit dire
**pourquoi** au lieu de laisser un littéral qui ressemble à un oubli. C'est E42
tenu, pas contourné. (4) **Un run sans ordre n'arme rien** : `armsCooldown` exige `ordersPlaced > 0`,
donc un run `ACCEPTED` dont toutes les jambes ont été rejetées n'arme pas le
cooldown, et c'est correct. La sonde doit le couvrir, sinon on découvrira en
production qu'un run stérile gèle sept jours.

### S10 — Le domaine propre d'`order-id`, et la fin de `DECALAGE_DE_JAMBE`

**Dépend de** : **rien**. Parallélisable dès la vague 1. · **Critères** : E45, et
la moitié d'E21. · **Audit** : garde-fou → mutation **+** audit complet ; touche
`src/core/` → **`make coverage` obligatoire**. · **Diff estimé compté** : **~450
lignes**.
**Fichiers prévus** : `src/core/order-id.ts`, `src/jobs/liquidate.ts`,
`test/core/order-id.test.ts`, `test/jobs/liquidate.test.ts`,
`docs/sortie-propre.md`.

**Résultat** : la sortie reçoit son **domaine propre** dans
`src/core/order-id.ts`, à côté d'`ubac.order-id.v1`, et `DECALAGE_DE_JAMBE`
disparaît.

**Pourquoi maintenant.** `docs/sortie-propre.md` désigne lui-même le décalage à
900 comme un contournement : Q7 n'avait pas mandat de toucher à `core/`. La
phase 3 arme la sortie, donc **elle rend la collision réelle**. Une collision de
`client_order_id` entre le run quotidien et une sortie lancée le même jour ne
produit **aucune erreur** — l'exchange avale le second envoi au titre du
doublon — et laisse le portefeuille à moitié liquide. C'est le type de panne
qu'aucun test ne trouve après coup. **Ce lot ne dépend de rien** : ni d'une clé,
ni d'une route, ni d'une chaîne ; le placer tôt libère S11 et occupe un worker
pendant que S2 et S4 se suivent sur `coinbase.ts`.

**Validation** : une sortie et un run quotidien **du même jour, du même actif, du
même côté et du même `legIndex`** produisent deux `client_order_id` différents ;
l'identifiant du run quotidien ne change pas d'un octet ; `DECALAGE_DE_JAMBE`
n'existe plus. **Mutation** : rendre le même domaine aux deux — la sonde de
collision rougit.

**Pièges.** (1) **L'identifiant du run quotidien ne doit pas bouger** : le test
fige la valeur attendue, et le module dit pourquoi — « un changement d'encodage
entre deux déploiements rouvre la porte au doublon ». Le domaine existant reste
`ubac.order-id.v1` **à l'octet près**. (2) **La sonde d'E45 ne prouve rien si
elle est mal écrite** : avec le décalage à 900, deux identifiants diffèrent déjà
parce que le `legIndex` diffère, donc une sonde écrite avec des `legIndex`
différents passe **avant et après** le lot. **L'écrire avec le même `legIndex`**
— c'est la seule rédaction qui distingue les deux implémentations. (3) `core/`
est sous seuil de couverture et sous règles de pureté : `node:crypto` n'y est
admis que pour `createHash`.

### S11 — La sortie propre armée : le verrou retiré, la commande CLI, l'ordre O7

**Dépend de** : **S4**, **S5**, **S7**, **S10** fusionnés. · **Décisions** : B5,
O7 = 2, T5. · **Critères** : E43, E44, E46, E47, E48, E49, et l'extension
d'E11. · **Audit** : argent + garde-fou → mutation **+** audit complet. ·
**Diff estimé compté** : **~950 lignes** — **point de redécoupe à couper avant le
dispatch**.
**Fichiers prévus** : `src/jobs/liquidate.ts`, `src/jobs/liquidate-main.ts`
(neuf), `src/jobs/execute.ts`, `test/jobs/liquidate.test.ts`,
`test/jobs/liquidate-verrou.test.ts` (**supprimé**), `test/jobs/purete.test.ts`,
`docs/sortie-propre.md`.

**Résultat** : `appliquerSortie` **applique**. La sortie a sa commande CLI, relit
les soldes et les ordres ouverts avant d'appliquer, désarme le déclencheur **en
premier**, et son rapport est `REALISE`.

**Le verrou se retire avec les tests qui le gardaient.** `SortieVerrouillee`,
`PHASE_COURANTE`, `PHASE_D_APPLICATION` et `test/jobs/liquidate-verrou.test.ts` —
**497 lignes**, V1 à V11 plus W1 et W2 — partent dans ce lot. E43 est explicite :
« le verrou ne se lève pas, il se retire », et laisser le fichier vert à vide
serait pire que de ne rien avoir.

**Mais tout ne doit pas partir, et c'est T5.** V6 (module synchrone) et V7
(imports énumérés) tombent **nécessairement** — une sortie qui applique attend un
exchange. **V8** (surface publique exactement celle-ci) et **V9** (aucune chaîne
de contournement) n'ont aucune raison de tomber : les faire disparaître avec le
verrou retirerait 497 lignes de garde-fou pour en rendre zéro.

**Validation** : `appliquerSortie` rend un succès, et le type d'un succès
existe ; une sortie et un run quotidien du même jour ne se marchent pas dessus ;
le déclencheur est désarmé **avant** la première annulation, et l'annulation
**avant** la cession ; `core/risk.ts` n'est ni appelée ni assouplie ; le rapport
porte `REALISE`, les cessions réellement exécutées, leurs frais et les résidus ;
`liquidate-main.ts` entre **nommément** dans A20 et A22. **Mutation** : replacer
le désarmement du déclencheur en troisième position — la sonde d'ordre rougit. Si
elle ne rougit pas, voir le piège 1.

**Pièges.** (1) **Le test d'ordre existant est conçu pour ne pas rougir ici.**
`test/jobs/liquidate.test.ts` confronte le plan au tableau `ETAPES` **plutôt qu'à
une liste réécrite dans le test** — c'était la bonne décision en Q7. Conséquence :
changer l'ordre du tableau **et** du plan ensemble ne fait rougir **aucun test**.
La sonde d'O7 doit porter sur le **fait** — le déclencheur est désarmé avant la
première annulation — et non sur l'égalité de deux listes qu'on modifie du même
geste. **C'est le piège le plus vicieux du lot.** (2) **Un second point de
composition** (E44) : A20 énumère `daily-main.ts` nommément et A22 le rend
inimportable ; `liquidate-main.ts` entre dans les deux **nommément**, jamais en
désarmant la règle — « deux composeurs énumérés valent mieux qu'un garde-fou
supprimé » est un critère, pas un conseil. (3) **E11 passe de un module à deux,
ou la sortie passe par `execute.ts`** : la recommandation est la seconde, qui
garde E11 littéral et donne gratuitement E48 — `execute.ts` place, il ne valide
pas, donc `core/risk.ts` n'est pas dans le chemin de la sortie. (4) **Les quatre
invariants repris ne sont pas les seuils du rebalancement** — contrepartie USDC,
limit post-only, plancher `MIN_LEG_USDC`, identifiant déterministe. Ils sont déjà
repris nommément dans `liquidate.ts` et le restent ; `MAX_EXPOSURE`, `MIN_CASH`
et le plafond réduit ne s'appliquent pas (E31, E48). (5) **La relecture avant
application** (E46) ferme la non-atomicité que `docs/sortie-propre.md` §5 pose
comme la charge de l'exécuteur de phase 3 : soldes et ordres ouverts dans la
**même passe** que le plan. (6) **Désarmer le déclencheur est un appel
Scaleway**, pas une écriture d'exchange : une **troisième** frontière externe
dans un lot qui en a déjà deux, et c'est la première raison de couper.
(7) **`PROJETE` devient `REALISE`**, donc le type change et tous ses lecteurs
avec — le compte de lignes vient autant de là que de la logique.

**Redécoupe** : **S11a** le verrou retiré, la sortie appliquée, la relecture et
le rapport `REALISE` ; **S11b** la commande CLI, l'entrée dans A20 et A22, et le
désarmement du déclencheur. La coupure isole la troisième frontière externe.

### S12 — Le bouton ntfy de la sortie

**Dépend de** : **S11** fusionné, et **E3** (canal ntfy fermé). · **Décision** :
O5 = 1. · **Critères** : E59, et E52 revérifié. · **Audit** : secret → mutation
**+** audit complet. · **Diff estimé compté** : **~550 lignes**.
**Fichiers prévus** : `src/jobs/alerts.ts`, `src/adapters/notifier.ts`,
`src/config/env.ts`, `test/jobs/alerts.test.ts`,
`test/adapters/notifier.test.ts`, `docs/alertes.md`.

**Résultat** : l'alerte de sortie porte un bouton **`view`** qui ouvre la console
Scaleway ; l'opérateur y lance le job à la main, et **aucun jeton ne voyage dans
une notification**. `Alert` n'a aujourd'hui **aucun champ d'action** et le job
aucune surface HTTP : le type, son rendu et sa relecture sont à écrire.

**Validation** : l'alerte de sortie porte l'action, les sept autres événements
partent sans ; une alerte dont l'action est illisible **ne part pas**, comme une
alerte dont le titre l'est ; aucun jeton, aucune URL signée, aucun secret dans la
charge utile publiée. **Mutation** : laisser l'action contourner la relecture
d'alerte — la sonde de l'action illisible rougit.

**Pièges.** (1) **La relecture est la défense, et elle doit couvrir le champ
neuf** : `lireAlerte` reconstruit un objet **plat** depuis l'`Alert` reçue,
précisément parce qu'un getter posé sur `title` peut lever en citant un secret.
Un champ ajouté sans passer par elle serait le **seul** champ non défendu du
type. (2) **La clé déterministe ne doit pas changer** : `cleDe` canonicalise
`[KEY_DOMAIN, runDate, event, title, body]`, et y ajouter l'action changerait la
clé de **toutes** les alertes existantes, et l'idempotence de l'alerte avec.
**Ne pas l'ajouter** — l'action décore, la clé identifie l'événement. À écrire,
pas à supposer. (3) **L'URL de console entre par la configuration** : elle n'est
pas un secret mais elle identifie le projet et le job. (4) **Le canal doit être
fermé avant ce lot** (E3) : un bouton de liquidation sur un topic que n'importe
qui peut lire — et sur lequel n'importe qui peut publier — est exactement ce
contre quoi `docs/alertes.md` §5 bis fixe l'échéance « avant la phase 3 ». C'est
pourquoi E3 bloque **ce lot-ci**, pas seulement la phase en général. (5) **ntfy
refuse la publication entière si l'action est mal formée**, et l'alerte de sortie
est celle qu'on veut le plus recevoir : la sonde couvre le rendu exact de la
charge utile, pas seulement la présence du champ.

### S13 — Le jour de resynchronisation refuse d'exécuter

**Dépend de** : **PR #45 fusionnée** (E2), et **S7** fusionné. · **Décisions** :
O6 = 1, T6. · **Critères** : E60. · **Audit** : argent → mutation **+** audit
complet. · **Diff estimé compté** : **~400 lignes**.
**Fichiers prévus** : `src/jobs/daily.ts`, `test/jobs/daily.test.ts`,
`docs/reconciliation.md` §3 bis.

**Résultat** : un jour où la réconciliation a resynchronisé l'état, **l'étape 6
ne place rien** ; le run journalise, écrit ses décisions et sa photo, rend compte
et conclut.

**Ce lot n'a d'objet qu'une fois #45 fusionnée**, et ce n'est pas une formule :
sans elle, une divergence au-delà de 1 % abandonne le run **avant toute
décision**, donc aucun jour de resynchronisation n'existe et E60 serait tenu
trivialement. **Si #45 est fusionnée avant le dispatch de S7, ce lot se replie
dans S7 et disparaît** ; le coordinateur tranche alors, et c'est pourquoi S13
existe séparément.

**Validation** : un run marqué `ETAT_RESYNCHRONISE` ne produit aucun ordre, et un
run du lendemain sur les mêmes soldes en produit ; le refus porte son motif, il
n'est jamais une omission. **Mutation** : retirer la condition de refus — la
sonde du jour resynchronisé rougit.

**Pièges.** (1) **Le refus s'écrit, il ne se déduit pas** : « l'option 3 ne doit
être retenue que si elle est **explicitement choisie**, jamais par omission » est
le mot de #45, et il vaut à l'envers — le refus d'exécuter doit se journaliser et
se sonder, pas résulter d'un chemin qui n'atteint pas l'étape 6. (2) **Le run
conclut quand même** : il écrit, il rapporte, il pingue ; seule l'étape 6 est
sautée. Un run qui abandonnerait ne reposerait pas de photo — la panne en boucle
que #45 vient de fermer. (3) **Aucune seconde alerte** (T6) :
`RECONCILIATION_DRIFT` part déjà en `URGENT`, et `ETAT_RESYNCHRONISE` marque
durablement les quatre lignes de `decisions` ; une seconde alerte dirait deux
fois la même nouvelle, et c'est le texte de l'existante qui doit dire que rien
n'a été placé.

### S14 — La clôture de la phase 3

**Dépend de** : **tous les lots fusionnés**, et le mois d'E56 entamé. ·
**Critères** : E50 à E55 revérifiés sur le code livré, E56, E57, E58. ·
**Audit** : **mutation seule** — aucun secret, aucune écriture, aucun garde-fou
neuf : le seul lot de la phase dans ce cas. · **Diff estimé compté** : **~450
lignes**, en majorité documentaires.
**Fichiers prévus** : `docs/phase-1-frontieres.md`, `docs/run-quotidien.md`,
`docs/sortie-propre.md`, `docs/reconciliation.md`, `docs/alertes.md`,
`docs/plans/ubac-phase-3.md`, `docs/specs/ubac-phase-3.md`.

**Résultat** : ce que la phase 3 garantit et ce qu'elle ne garantit pas est écrit
**une fois**, et la sortie de phase est prononçable. **Le mois d'E56 n'est pas un
lot.** Il ne se dispatche pas, il s'observe. Il court
à partir du **premier run à pleine taille**, c'est-à-dire après le commit de
levée du plafond (E34) — pas à partir du premier run armé sous plafond. S14 écrit
la règle et le point de départ ; la sortie se prononce dans Orca quand le mois
est écoulé, **explicitement**, jamais déduite du calendrier.

**Validation** : aucune affirmation de la documentation ne contredit le code
livré ; les commandes citées existent ; les renvois croisés pointent vers des
sections qui existent encore ; `make check` passe. **Piège** : **c'est un lot de
suppression et de réécriture, et cela ne rougit nulle part.** Le seul contrôle
est la relecture croisée des renvois — même leçon que R7 de la phase 2.

## Couverture des critères E1 à E60

Exhaustive. Un critère sans lot est un critère qu'on découvre à la sortie de
phase.

| Critère | Lot | Note |
|---|---|---|
| E1 à E5 | **portes** | E1 bloque S6 et S7 (T1), E2 bloque S13, E3 bloque S12, E4 bloque S1 et S7, E5 bloque S7 |
| E6, E8 | **S1** | |
| E7 | **S1** (moitié acquise) + **S4** (`can_trade` à la construction) | |
| E9, E10, E11 | **S4** | E11 étendu par **S11** |
| E12 | **S5**, vérifié par l'ordre dans `main` (S5 < S7) | |
| E13 | **S6** | seul critère qui exige la phase 2 |
| E14, E15, E16 | **S5** | |
| E17 | **S5** | **constaté** : le test de contrat de `risk.ts` reste vert |
| E18 à E24, E26 | **S7** (ou S7a) | E24 exige `make test-db` |
| E25 | **acquis** (Q9), protégé par R3 — **revérifié en S7** | |
| E27, E28 | **S7** (ou S7b) | E28 part du rapport de #47 et #49, fusionnées |
| E29, E30 | **S3** | |
| E31 | **S3** | porte sur l'effet, pas sur les verdicts |
| E32 | **S3** | **acquis** depuis la phase 0 et Q6a2 : constaté sur la nouvelle valeur |
| E33 | **sans objet** | clos par O2 = 3 ; numéro conservé |
| E34 | **S3**, et le commit de levée — **hors plan** | O3 = 3 |
| E35, E36 | **S8** | T4 |
| E37 | **S2** | |
| E38 | **S8** | |
| E39 | **S8** | **revérifié, inchangé** |
| E40, E41 | **S9** | |
| E42 | **S9** | l'ancre de B reste `null`, motivée |
| E43, E44, E46, E47, E48, E49 | **S11** | E47 = O7 |
| E45 | **S10** | |
| E50 | **tous** — revérifié en **S14** | `src/core/` reste pur |
| E51 | **tous** — porté par **S2** et **S7** — revérifié en **S14** | aucun `number` flottant |
| E52 | **tous** — porté par **S1** et **S12** — revérifié en **S14** | aucun secret en clair |
| E53 | **S3** et **S10** (les deux lots qui touchent `core/`) ; porté par la chaîne (R1) | `make coverage` |
| E54, E55 | **tous** | plafond de 1 000 lignes ; tout passe par Docker |
| E56, E57, E58 | **S14** | O4 = 1 ; le mois s'observe, il ne se dispatche pas |
| E59 | **S12** | O5 = 1 |
| E60 | **S13** | O6 = 1 ; sans objet tant que #45 est en vol |

## Ordre, vagues et sérialisation

**Cette phase se parallélise mal, et il faut le dire.** Trois workers ne sont
utilisables qu'à la première vague. La raison n'est pas le découpage : c'est que
la phase construit **un seul chemin d'exécution**, couche par couche, et que cinq
fichiers — `coinbase.ts`, `daily.ts`, `db.ts`, `liquidate.ts`, `alerts.ts` — sont
touchés par presque tous les lots.

| Vague | Lots | Workers | Ce qui les sépare |
|---|---|---|---|
| **1** | **S1**, **S3**, **S10** | **3** | `coinbase.ts`+`env.ts` / `risk.ts` / `order-id.ts`+`liquidate.ts` |
| **2** | **S2** | 1 | `coinbase.ts` libéré par S1 |
| **3** | **S4** | 1 | le pivot : `eslint.config.js`, `structure.test.ts`, `coinbase.ts`, `purete.test.ts` |
| **4** | **S5** | 1 | `daily-main.ts`, `purete.test.ts` |
| **5** | **S6** *(si phase 2 livrée)* | 1 ou 0 | `.github/`, `test/ci/` — vague vide sinon, et S7 part sur le repli T1 |
| **6** | **S7** | 1 | **le premier ordre réel.** Rien en parallèle sur ses fichiers |
| **7** | **S8**, **S11** | **2** | `reconcile.ts`+`db.ts` / `liquidate.ts`+`liquidate-main.ts` |
| **8** | **S9**, **S12** | **2** | `daily.ts`+`db.ts` / `alerts.ts`+`notifier.ts` |
| **9** | **S13** | 1 | `daily.ts`, libéré par S9 |
| **10** | **S14** | 1 | documentation |

**Volume total estimé : ~9 700 lignes**, déjà corrigées du facteur observé en
phase 1 ; **six lots, ~4 450 lignes, avancent sans la phase 2**.

**Fichiers à sérialiser**, même sans dépendance métier :

| Fichier | Lots qui l'écrivent | Aussi touché par |
|---|---|---|
| `src/adapters/coinbase.ts` | S1, S2, S4 | — |
| `src/jobs/daily.ts` | S5, S7, S8, S9, S13 | **#45** |
| `src/adapters/db.ts` | S7, S8, S9 | — |
| `src/jobs/alerts.ts` | S7, S12 | **#45** |
| `src/jobs/liquidate.ts` | S10, S11 | **#45** |
| `src/jobs/reconcile.ts` | S8 | **#45** |
| `src/report/daily-report.ts` | S7 | — |
| `src/jobs/execute.ts` | S4, S7, S8, S11 | — |
| `test/jobs/purete.test.ts` | S4, S5, S11 | — |
| `src/config/env.ts` | S1, S12 | — |

**Le coordinateur peut dispatcher hors périmètre pendant les vagues 2 à 6**, qui
laissent deux workers libres en permanence : les lots R1 à R4 de la phase 2 sont
les candidats naturels, et ils débloquent S6 et le chemin nominal de S7.

## Ce que la phase 3 ne garantira pas

À écrire dans la documentation plutôt qu'à laisser croire. S14 le porte, mais
chaque lot concerné le déclare à sa livraison.

- **La surface d'écriture est énumérée, pas prouvée.** E10 et E11 disent quelles
  routes existent et qui les appelle ; ils ne disent pas qu'un client HTTP
  générique ne peut pas en fabriquer une autre. Même limite que le lint retiré,
  déplacée. **La seule garantie structurelle reste la clé** : `can_transfer`
  faux, scopée sur le portefeuille dédié, vérifiée contre une valeur attendue
  (E6).
- **L'index unique de `decisions` et la clé primaire d'`orders` ne sont pas
  couverts par la chaîne** (D2) : ce sont les deux lignes de défense d'E24 contre
  l'ordre double. Le trou est déclaré, pas comblé ; `make test-db` sur le poste
  est ce qui le tient.
- **Un `DRY_RUN` prouve ce que les ports reçoivent, pas ce que le processus
  fait** — un effet passé autrement échappe à la sonde, comme W2 le constate déjà
  pour le verrou de sortie.
- **Le retour en arrière n'a pas de procédure écrite** tant que D12 de la phase 2
  n'est pas tranchée, et **le repli de T1 dépend du même chemin manuel**.
- **Les cinq autres limites sont celles de la spec** et ne sont pas recopiées
  ici : scoping v2 non tranché, phase possible sans aucun rééquilibrage, aucune
  conclusion sur la stratégie (E58), frais réels inconnus, PRU non tranché. La
  dernière a une conséquence de plan : les données de n'importe quelle méthode de
  PRU doivent être dans `orders` **dès le premier ordre**, sans quoi elles seront
  perdues — c'est E38, et c'est S8.

## Sur la durée annoncée

Aucune estimation en soirées, pour trois raisons mesurées : les estimations de ce
dépôt se sont trompées d'un **facteur 2 à 3**, toujours sur les frontières
externes, et la phase 3 en compte quatre ; **une fixture d'ordre exécuté ne peut
pas être capturée avant qu'un ordre existe** ; et **la moitié de la phase attend
la phase 2**. Les temps réels se mesurent pendant les cycles Orca.
