# Ubac phase 3 : activation de l'exécution

Cadrage du 2026-09-20 · restreint et durcit `docs/specs/ubac-rebalance.md` v2.0
pour la seule phase 3. `main` à `4514aff`, état du dépôt constaté et non
supposé.

## Besoin

Armer l'étape 6 du §8 : la stratégie active place enfin ses jambes sur Coinbase,
en limit post-only, avec une taille d'abord plafonnée puis pleine. Fermer en
même temps les trois écritures que les phases 1 et 2 ont reportées ici :
l'annulation des ordres de plus de 24 h, le `DRY_RUN` du §10, et la sortie
propre du §14 qui est écrite mais refuse de s'appliquer. C'est la première phase
qui engage de l'argent réel ; en cas de contradiction avec la v2.0 sur le
périmètre phase 3, **c'est ce fichier qui fait foi**.

### Pourquoi cette spec existe

Les phases 1 et 2 ont été planifiées **sans spec dédiée**, et les deux plans le
signalent eux-mêmes : « la référence est une sous-section de dix lignes du §10,
pas une liste de critères numérotés » (`docs/plans/ubac-phase-2.md`). Les
critères de validation des lots tenaient lieu de critères d'acceptation, ce qui
revient à faire relire un lot contre ce que son propre plan a décidé qu'il
ferait. La faiblesse était supportable tant que rien ne s'exécutait. La phase 3
engage de l'argent, et l'opérateur a demandé le cadrage (décision **B1**).

## Ce que la phase 3 suppose livré

### Acquis, qu'aucun lot de cette phase ne refait

| Acquis | Où | Ce qu'il donne à la phase 3 |
|---|---|---|
| Noyau pur, `risk.ts` à 100 % | `src/core/` | les neuf règles, `armsCooldown`, `cooldownAnchor`, `clientOrderId` |
| Lecteur Coinbase | `src/adapters/coinbase.ts` | quatre routes de **lecture** énumérées, contrôle de rattachement par compte |
| Réconciliation | `src/jobs/reconcile.ts` | soldes marqués, transitions d'ordres calculées, deux observations |
| Run quotidien, étapes 1 à 5 et 7 à 9 | `src/jobs/daily.ts` | tout sauf l'étape 6 |
| Plan de sortie complet | `src/jobs/liquidate.ts` | les quatre étapes du §14 en intentions, verrouillées |
| Table `orders` | `src/adapters/schema.ts` | le schéma existe ; **aucune écriture ne l'alimente** |
| Alerte `REBALANCE_EXECUTED` | `src/jobs/alerts.ts` | l'entrée existe au catalogue ; **jamais émise** |
| Image, job Scaleway, cron, Neon, updown | phase 1 lot Q9, `docs/deploiement.md` | la production tourne, déployée **à la main** |

### Dépendances non satisfaites au moment de ce cadrage

| Dépendance | État au 2026-09-20 | Conséquence si elle n'est pas levée |
|---|---|---|
| Phase 2, lots **R1 à R4 et R7** | **planifiés, aucun livré** — pas de `.github/`, pas de `test/ci/`, pas de `docs/integration-continue.md` | aucune porte de test automatique, aucun déploiement par la chaîne : la phase 3 déploierait à la main du code qui place des ordres |
| **PR #45** (Q10, la réconciliation rafraîchit le cache) | ouverte, non fusionnée, 779+/278− | le sens de la réconciliation change sous la phase 3, et la décision de sa section 3 bis n'a pas d'objet tant qu'elle n'est pas fusionnée |
| Lecture du **statut réel d'un ordre** et de ses exécutions | absente de `CoinbaseReader` | un ordre `PENDING` dont l'issue est inconnue le reste pour toujours ; `docs/reconciliation.md` §4 la pose déjà en prérequis de la phase 3 |
| **Canal ntfy fermé** | ouvert, déclaré par la sentinelle `CANAL-PUBLIC-SANS-JETON` | quiconque connaît le topic publie de fausses alertes ; `docs/alertes.md` §5 bis fixe l'échéance « avant la phase 3 » |
| **Nouvelle clé** avec `can_trade`, portefeuille approvisionné | la clé de la phase 1 est en lecture seule, contrôle du 2026-09-11 | rien ne peut s'exécuter |

**La phase 3 ne commence pas avant que ces cinq lignes soient closes.** Ce ne
sont pas des lots de cette phase : ce sont ses conditions d'entrée, et le plan
les portera en porte, pas en étape.

## Périmètre

### Inclus

**L'étape 6 du §8** — l'exécution des jambes de la stratégie active, et d'elle
seule : un port d'exécution, un adapter Coinbase qui l'implémente, l'écriture
dans `orders`, et l'alerte `REBALANCE_EXECUTED` qui attend au catalogue depuis
Q6a2.

**Le plafond réduit (B2)** — l'armement progressif de la taille des jambes, puis
sa levée.

**Les trois écritures reportées ici** :

| Report | Par | Ce qu'il faut écrire |
|---|---|---|
| Annulation des ordres limit de plus de 24 h (§7, point 3) | **D2** du plan de phase 1 | l'horloge devient un paramètre de `ReconcileInput` ; l'annulation est une écriture sur l'exchange |
| `workflow_dispatch` + `DRY_RUN=true` (§10) | **D9, D10, D11** du plan de phase 2 | même image, adapter d'exécution remplacé par un mock qui journalise |
| Sortie propre armée (§14) | **D3** du plan de phase 1, lot Q7 | le verrou se **retire**, la commande CLI et le bouton ntfy existent |

**La mise à jour des `orders`** (§7, réconciliation point 2) — calculée depuis
Q4a, jamais persistée. Elle ne peut l'être qu'une fois la lecture manquante
livrée.

**L'alimentation du cooldown** — `armsCooldown` et `cooldownAnchor` existent et
sont testés ; `src/jobs/daily.ts` pose `lastCompleteRebalanceOn: null` en dur.
Ce qui manque est la lecture de l'historique d'exécutions, pas la règle.

**Le retrait du garde-fou de phase (B4)**, et ce qui le remplace.

### Exclu explicitement

- **Toute permission de retrait.** `can_transfer` reste faux, en phase 3 comme
  après. Ce n'est pas un arbitrage : c'est l'exigence du §7, et
  `docs/cle-coinbase.md` documente pourquoi on retient la lecture la plus
  défavorable de cette permission.
- **Toute modification des neuf règles de `core/risk.ts`** autre que le plafond
  décidé en B2, et
**aucun mode de contournement** : pas de `dryRun`, pas de `force`, pas de
`bypass`. Le `DRY_RUN` du §10 vit au point de composition, jamais dans le noyau.
- **Le PRU et l'export CSV des cessions** (§11). Inchangé depuis la phase 0 : la
  méthode de PRU n'est pas tranchée et se décide avec le comptable.
- **L'ajustement des bandes** : c'est la phase 4. L'ajuster pendant la phase 3
  rendrait inattribuable ce que la phase 3 observe.
- **La promotion du déclencheur B.** `rebalance_ab` reste shadow ; en phase 3, «
  shadow » cesse d'être une étiquette de rapport pour devenir une garantie
  d'exécution.
- **Le ladder et le DCA** : shadow, aucune jambe placée, quel que soit leur
  verdict.
- **Toute migration depuis la chaîne** (`docs/base-de-donnees.md` §5), inchangé.
- **Toute conclusion sur la valeur de la stratégie.** Un mois de rééquilibrages
  réels, avec 4 à 8 déclenchements par an, ne démontre rien. La phase 3 valide
  l'exécution, pas la stratégie.

## Décisions prises pendant le cadrage

### Reportées de l'opérateur, non rouvertes ici

| # | Décision | Ce qu'elle impose à cette spec |
|---|---|---|
| **B1** | Cadrage d'abord, avec critères numérotés, puis plan | ce fichier ; le plan de phase 3 s'y adosse au lieu de se référer à une sous-section de la v2.0 |
| **B2** | Armement progressif par **plafond réduit** sur la taille des jambes, puis levée. **Pas** d'approbation manuelle par bouton ntfy | un plafond existe, il est temporaire, et rien n'attend un humain dans la boucle d'exécution |
| **B3** | Le `DRY_RUN` est un **lot prérequis**, livré et éprouvé **avant** tout ordre réel | E12 à E17 ; l'ordre des lots est une contrainte de plan, pas une préférence |
| **B4** | Le garde-fou ESLint d'écriture d'ordre est **retiré** | E9 à E11, et l'inventaire de ce que le dépôt perd, ci-dessous |
| **B5** | La sortie propre est **déverrouillée et armée**, avec sa commande CLI et son bouton d'action ntfy | E43 à E49, et **E59** pour le bouton (forme tranchée par O5) |

Sur **B2**, la spec note que « pas d'approbation manuelle » est cohérent avec la
décision **D7** de la phase 2, qui a déjà retiré l'humain de la boucle de
déploiement. Le système n'attend personne, ni pour déployer, ni pour exécuter.
C'est un choix assumé, et il déplace toute la charge de sûreté sur le plafond,
la clé et la couche risque.

### Prises par ce cadrage, sur des points que le dépôt tranchait déjà

Aucune de ces quatre n'est un choix de besoin : chacune suit d'une contrainte
déjà écrite ailleurs dans le dépôt. Elles sont listées pour être contestables,
pas pour être découvertes en revue.

| Point | Retenu | Parce que |
|---|---|---|
| Un `DRY_RUN` écrit-il en base ? | **Non**, rien : ni `decisions`, ni `snapshots`, ni `orders`, ni rapport, ni ping | la photo du jour porte un indice de croissance qui se rechaîne sur lui-même ; un `DRY_RUN` qui en poserait une casserait la chaîne du run réel. **D10** avait déjà écarté le rapport Brevo ; le reste suit du même raisonnement |
| L'ordre est-il écrit avant ou après le placement ? | **Avant**, en `PENDING` | un job interrompu après un placement non écrit laisse un ordre que rien ne réclame ; l'inverse laisse une ligne que la réconciliation du lendemain rattrape |
| Le `portfolio_uuid` attendu | **variable de configuration**, comparée aux permissions effectives | le contrôle actuel est auto-référentiel : il ne détecte pas une clé scopée sur *Primary*. Voir les hypothèses challengées |
| Le `DECALAGE_DE_JAMBE` à 900 | **supprimé**, au profit d'un domaine propre dans `core/order-id.ts` | `docs/sortie-propre.md` le désigne lui-même comme un contournement ; la phase 3 est la phase qui rend la collision réelle |

## Décisions prises par l'opérateur

Posées le 2026-09-20 (`ask` msg_0e346d07ec1e), **répondues le même jour** :
`O1=3 O2=3 O3=3 O4=1 O5=1 O6=1 O7=2`. Ce sont exactement les sept
recommandations que ce cadrage portait ; elles ne sont donc pas des arbitrages
surprises, et chacune est reprise ci-dessous avec son motif retenu.

Les cinq premières (O1 à O5) venaient des trous que B2 et B5 laissaient ; les
deux dernières (O6 et O7) étaient déjà réservées à l'opérateur par les lots
précédents, avec l'échéance « avant la phase 3 ».

| # | Question | Réponse retenue |
|---|---|---|
| **O1** | Forme du plafond réduit (B2) | **3 — fraction de la valeur du portefeuille par run**, c'est-à-dire `REBALANCE_TOO_LARGE_PCT` abaissé. **Valeur retenue le 2026-09-21 : 8 %** au lieu de 25 %, mesurée sur le rejeu et non estimée — voir E29 |
| **O2** | Que fait le système quand une jambe dépasse le plafond ? | **3 — pas de rabotage.** Le run entier est refusé ; le portefeuille reste hors bande jusqu'à la levée du plafond |
| **O3** | Par quel geste le plafond est-il levé ? | **3 — un geste explicite** : changement de constante dans le code, PR relue, déploiement. Jamais automatiquement, jamais par variable d'environnement |
| **O4** | Qu'est-ce qui clôt la phase 3 ? | **1 — un mois calendaire de runs armés sans incident**, même si aucun rééquilibrage n'a eu lieu |
| **O5** | Le bouton ntfy de la sortie propre (B5) | **1 — un bouton `view`** qui ouvre la console Scaleway ; l'opérateur lance le job à la main. Aucun jeton ne voyage dans une notification |
| **O6** | Un jour de resynchronisation autorise-t-il l'exécution ? | **1 — non.** Le run journalise sans placer |
| **O7** | L'ordre des étapes de la sortie propre | **2 — désarmer le déclencheur en premier**, puis annuler, céder, rapporter |

### Ce que ces réponses changent, et ce qu'elles coûtent

**O1 = 3 et O2 = 3 se referment l'une sur l'autre, et le plafond devient
presque gratuit.** `REBALANCE_TOO_LARGE` refuse déjà le run entier : c'est une
`Rejection` du verdict, pas un écrêtage de jambe. La forme retenue en O1 est
donc **exactement** celle que O2 demande, et le plafond réduit se ramène à une
constante abaissée dans `core/risk.ts`. Le cadrage tenait aussi pour acquis,
depuis la phase 0, le motif écrit dans `decisions.reason` et l'alerte
`REBALANCE_TOO_LARGE` qu'E32 exige, sans l'avoir vérifié. La revue du lot du
plafond l'a infirmé pour le motif : `decisions.reason` ne portait que le motif
de l'intention, le code du rejet vivant seul dans `risk_verdict`. Le lot du
plafond satisfait E32 en composant le motif de l'intention et celui du rejet ;
l'alerte, elle, existait bien.

**O2 = 3 rend E33 sans objet**, et c'est la conséquence la plus utile des
sept : aucun run raboté n'existe, donc `armsCooldown` n'a pas à distinguer un
rééquilibrage volontairement incomplet d'un rééquilibrage complet, donc
`core/risk.ts` n'est pas touchée sur ce point et sa couverture à 100 % n'est pas
remise en jeu par une branche nouvelle.

**O2 = 3 a un coût, et il est assumé** : entre le dépassement et la levée du
plafond, le portefeuille **reste hors bande**, run après run, sans que rien ne
le ramène. Ce n'est pas un état dégradé silencieux — E32 fait partir une alerte
chaque jour — mais c'est un état qui dure tant que personne ne lève le plafond.
C'est le prix de ne pas armer un cooldown de sept jours sur un rééquilibrage
qu'on a soi-même empêché d'aboutir.

**O1 = 3 déborde sur les stratégies shadow, et le plan doit le dire.**
`validate()` est appelée pour les quatre stratégies, la production comme les
ombres. Abaisser la constante change donc aussi les verdicts de `rebalance_ab`,
`ladder` et `dca`, qui ne placent rien : on verra davantage de
`REBALANCE_TOO_LARGE` dans `decisions`, dans le rapport et dans les alertes,
sans qu'aucun ordre ne soit en cause. E31 — « le plafond s'applique à la
stratégie active et à elle seule » — porte sur l'**effet** (quelles jambes sont
empêchées), pas sur les verdicts prononcés. Introduire un plafond par stratégie
donnerait à la couche risque un paramètre de plus, ce qu'E30 refuse.

**O3 = 3 fait de la levée un commit.** La date et le geste sont lisibles dans
l'historique de `main` sans qu'aucun mécanisme n'ait à les enregistrer : c'est
E34, et il est tenu par le dépôt lui-même. L'option 4 aurait contredit
`docs/phase-1-frontieres.md` §3, qui fait échouer le démarrage sur toute
variable préfixée `UBAC_RISK_`.

**O4 = 1 découple la sortie de phase du marché.** Un mois calendaire de runs
armés sans incident se constate ; N rééquilibrages réels dépendent de 4 à 8
franchissements de bande par an et d'une jambe post-only qui peut ne jamais
s'exécuter. Le §13 prévient déjà que la période peut n'en montrer aucun.

**O5 = 1 oblige à étendre `Alert`.** Le type ne porte aujourd'hui que `event`,
`priority`, `runDate`, `title` et `body` ; un bouton demande un champ d'action,
son rendu dans `notifier.ts`, et sa validation dans la relecture d'alerte qui
refuse une alerte illisible. C'est un critère neuf : **E59**.

**O6 = 1 n'a d'objet qu'une fois la PR #45 fusionnée.** Sans elle, une
divergence de solde abandonne le run avant toute décision, donc aucun jour de
resynchronisation n'existe et rien ne peut exécuter ce jour-là. C'est un
critère neuf : **E60**.

**O7 = 2 est un écart assumé avec le §14**, dont l'étape 3 désactive le cron
**après** les cessions. Le motif est la fenêtre relevée par
`docs/sortie-propre.md` §5 : un run quotidien qui tombe pendant une sortie
relirait un portefeuille en cours de liquidation et y répondrait. Cette fenêtre
est théorique en phase 1 parce que rien ne s'exécute ; elle cesse de l'être
exactement au moment où cette spec arme les deux chemins. L'ordre livré devient
donc **DECLENCHEUR, ANNULATION, CESSION, RAPPORT**, et `ETAPES` de
`src/jobs/liquidate.ts` le dit. Le rapport entre l'annulation et la cession ne
change pas : l'annulation précède toujours la cession, parce que la quantité
cédée inclut le gelé (E47).

## Hypothèses challengées

### Le retrait du garde-fou ESLint (B4) : ce que le dépôt perd, et ce qui le remplace

**La décision est prise et ce cadrage ne la rouvre pas.** Le motif retenu par
l'opérateur est juste, et `docs/phase-1-frontieres.md` l'écrivait déjà : « le
lint réduit la surface d'erreur ; la clé est ce qui rend l'erreur impossible ».
Une règle qui interdit de **nommer** un placement d'ordre ne peut pas cohabiter
avec une phase dont l'objet est d'en placer.

Ce que la spec doit dire, c'est le **solde de l'opération** — un garde-fou
retiré sans inventaire est un garde-fou dont plus personne ne sait ce qu'il
tenait.

**Ce qui disparaît.** La règle ne prouvait pas l'absence d'exécution ;
`phase-1-frontieres.md` énumère ses cinq trous. Mais elle tenait une propriété
que rien d'autre ne tient : **aucun module de `src/adapters/**` et `src/jobs/**`
ne prononce un verbe d'écriture d'ordre, ou il rougit**. Elle attrapait donc
l'erreur qui compte vraiment ici — un placement écrit **ailleurs** que dans le
module prévu pour ça. Avec elle, l'exécution ne pouvait apparaître qu'en faisant
rougir la suite ; sans elle, elle peut apparaître en silence dans n'importe
lequel des fichiers de ces deux répertoires.

**Ce qui ne la remplace pas.** La clé `can_trade` ne remplace pas ce que le lint
tenait. Elle répond à « l'argent peut-il sortir ? » — non, `can_transfer` est
faux — et à « quel portefeuille est atteignable ? ». Elle ne répond pas à « quel
module de ce dépôt place des ordres ? ». Les deux garanties ne portent pas sur
le même objet, et la seconde disparaît vraiment.

**Ce qui la remplace, et que cette spec porte en critères numérotés** — une
**énumération positive** au lieu d'un filtre de noms négatif, donc une garantie
plus forte et pas seulement différente :

1. **Une seule surface d'écriture, énumérable à l'exécution.** `CoinbaseRoute`
   énumère aujourd'hui quatre routes de lecture, et `READ_ROUTES` les rend
   comptables par un test. La phase 3 y ajoute les routes d'écriture, nommément,
   et un test énumère la surface exacte : ajouter une route devient une
   modification visible, pas un appel de plus.
2. **Un seul module qui les appelle**, et un garde-fou de `test/jobs/` qui lui
   en réserve l'usage — la forme exacte que `docs/reconciliation.md` §5 emploie
   déjà pour réserver `.balances()` à `reconcile.ts`.
3. **Les permissions effectives, lues à l'API à chaque run** et confrontées à ce
   qu'on attend, `portfolio_uuid` compris.

Le point 3 est le seul que la décision B4 nommait. Les points 1 et 2 sont ce que
ce cadrage ajoute, et sans eux le retrait serait une perte sèche.

### Le contrôle de portefeuille est auto-référentiel, et la phase 3 le rend dangereux

`balanceFrom` refuse un compte dont le `retail_portfolio_id` ne vaut pas le
`portfolio_uuid`
**rendu par la clé elle-même**. Le contrôle prouve donc que la réponse est
cohérente avec la clé, pas que la clé est scopée sur le bon portefeuille. Une
nouvelle clé de phase 3 créée par erreur sur *Primary* — le portefeuille
sélectionné **par défaut** dans le CDP Portal, comme `docs/cle-coinbase.md` le
souligne — passerait ce contrôle sans rien faire rougir.

En phase 1, la conséquence est une lecture du portefeuille principal. En phase
3, c'est un rééquilibrage complet exécuté dessus.

**Conséquence retenue** : l'UUID attendu devient une variable de configuration,
et le run refuse de démarrer si la clé n'est pas scopée dessus. C'est un critère
numéroté.

### Le `DECALAGE_DE_JAMBE` à 900 : la phase 3 est le lot qui doit le supprimer

`docs/sortie-propre.md` le dit de lui-même : décaler les numéros de jambe de la
sortie est un contournement, et la solution de fond est un **domaine propre**
dans `src/core/order-id.ts`, qui en a déjà un, versionné. Le lot Q7 n'avait pas
mandat de toucher à `core/`.

La phase 3 arme la sortie (B5) : c'est elle qui rend le doublon possible pour de
vrai. Une collision de `client_order_id` entre le run quotidien et une sortie
lancée le même jour ne produit
**aucune erreur** — l'exchange avale le second envoi au titre du doublon — et
laisse le portefeuille à moitié liquide. C'est exactement le type de panne
qu'aucun test ne trouvera après coup. Le contournement doit partir dans le lot
qui arme la sortie, pas après.

### « Post-only protège gratuitement » : ce n'est pas gratuit, et la spec le sait déjà

Un ordre post-only qui croiserait le carnet est **rejeté par l'exchange**. Sur
un marché qui bouge, une jambe peut donc ne jamais s'exécuter — le §7 le dit et
refuse d'en faire une erreur.

Ce n'est pas une hypothèse à changer : c'est le bon arbitrage. Mais il faut en
tirer la conséquence que ni le §7 ni le §13 ne tirent. **La phase 3 peut se
terminer sans qu'aucun rééquilibrage complet n'ait jamais abouti**, soit parce
qu'aucune bande n'a été franchie — 4 à 8 déclenchements par an —, soit parce que
les jambes ont été rejetées. Un critère de sortie de phase 3 qui exigerait un
rééquilibrage réel serait donc un critère que le marché, et non le code, décide
de satisfaire.

## Critères d'acceptation

Soixante critères, cités **E1 à E60** ailleurs dans le dépôt. Le préfixe `C`
est déjà pris par les trente-deux critères de la phase 0 — `C21` y désigne le
cooldown —, et deux jeux de critères qui partagent un préfixe finissent par se
confondre en revue.

Le cadrage en posait cinquante-huit ; **E59 et E60 ont été ajoutés à la suite**
par les réponses O5 et O6, et **E33 est devenu sans objet** par la réponse O2
sans que son numéro soit réattribué. La numérotation ne se recompacte jamais :
un `E41` doit désigner le même critère dans cette spec, dans le plan, dans une
PR et dans une tâche Orca.

**Conditions d'entrée — vérifiées avant le premier lot, pas pendant**

1. Les lots **R1 à R4 et R7** de la phase 2 sont fusionnés. Vérifiable :
   `.github/workflows/ci.yml` existe, la porte `test` est un contrôle requis sur
   `main`, et un merge produit une image taguée par son SHA puis un déploiement
   sans geste manuel.
2. La **PR #45** est fusionnée ou fermée. Si elle est fusionnée, la question de
   `docs/reconciliation.md` §3 bis a reçu sa réponse et cette spec la porte en
   critère.
3. Le **canal ntfy est fermé** : `NTFY_TOKEN` porte un jeton porteur et non la
   sentinelle `CANAL-PUBLIC-SANS-JETON`. Vérifiable : `runDaily` ne journalise
   plus `NTFY_CANAL_OUVERT_LIGNE`. Motif : un canal où n'importe qui publie et
   un bouton qui déclenche une liquidation ne peuvent pas coexister.
4. Une **nouvelle clé CDP** existe, créée pour la phase 3, scopée sur le
   portefeuille dédié, avec `can_view` et `can_trade` vrais et `can_transfer`
   faux. Vérifiable par `GET /api/v3/brokerage/key_permissions`, résultat
   reporté dans Orca comme celui de la clé de phase 1 l'a été le 2026-09-11. La
   clé de phase 1 est **révoquée** une fois la nouvelle en service : une clé
   dont plus personne ne sait si elle sert est une clé qu'on ne révoquera
   jamais.
5. Le **portefeuille dédié est approvisionné**, par virement interne depuis le
   *Primary*. Le montant est une décision de l'opérateur, hors spec ; ce qui est
   dans la spec, c'est qu'il soit non nul avant le premier run armé.

**La clé, et ce qui remplace le garde-fou retiré (B4)**

6. Le `portfolio_uuid` attendu est une **variable de configuration**, lue par
   `src/config/env.ts`. Le run **refuse de démarrer** si `key_permissions` ne
   rend pas exactement cet UUID. Le contrôle actuel de `balanceFrom` est
   auto-référentiel et ne couvre pas ce cas ; il reste, et ce critère s'y
   ajoute.
7. Le run **refuse de démarrer** si `can_trade` est faux alors que l'exécution
   est armée, et si une permission autre que `can_view` et `can_trade` est vraie
   — `can_transfer` comprise. Le second contrat existe déjà dans
   `permissionsFrom` ; le premier est neuf.
8. Les permissions effectives et le `portfolio_uuid` sont **journalisés à chaque
   run**, avant le premier ordre. Aucun secret n'apparaît : ni la clé, ni son
   secret, dans aucun journal ni aucun message d'erreur.
9. La règle `no-restricted-syntax` d'écriture d'ordre est **retirée**
   d'`eslint.config.js`, et dans le **même lot** : les fixtures
   `bad-order-write.fixture` et `bad-order-write-disabled.fixture` sont
   supprimées, le bloc « C32 (phase 1) » de `test/structure.test.ts` est
   supprimé, et `docs/phase-1-frontieres.md` §1 est réécrit pour dire ce qui
   tient désormais. Un garde-fou désarmé qui reste vert est pire que pas de
   garde-fou.
10. Un test **énumère la surface d'écriture** sur l'exchange, comme
    `READ_ROUTES` énumère aujourd'hui la surface de lecture : la liste exacte
    des routes d'écriture et la liste exacte des méthodes du port d'exécution.
    Ajouter l'une ou l'autre fait rougir la suite tant que le test n'est pas mis
    à jour.
11. Un garde-fou de `test/jobs/` **réserve l'appel des routes d'écriture à un
    seul module**, comme `docs/reconciliation.md` §5 réserve `.balances()` à
    `reconcile.ts`.

**Le `DRY_RUN`, lot prérequis (B3)**

12. Le `DRY_RUN` est **livré et éprouvé avant qu'aucun ordre réel ne parte**.
    Vérifiable : dans l'historique de `main`, le lot du mode précède le lot qui
    arme l'exécution.
13. `workflow_dispatch` avec un drapeau `DRY_RUN=true` déclenche le run **chez
    Scaleway** (D11), sur la **même image** que la production, taguée par son
    SHA.
14. En `DRY_RUN`, le port d'exécution est un **mock qui journalise** ce qu'il
    aurait placé : `client_order_id`, paire, côté, quantité, prix limite,
    `post_only`. Aucun appel réseau d'écriture vers Coinbase.
15. La substitution du mock se fait **au seul point de composition** —
    `src/jobs/daily-main.ts` et le point d'entrée de la sortie. Aucun module en
    aval ne sait s'il parle au mock ou à l'exchange : aucune condition
    `if (dryRun)` hors du point de composition.
16. Un `DRY_RUN` **n'écrit rien et n'envoie rien** : ni `decisions`, ni
    `snapshots`, ni `orders`, ni rapport Brevo (D10), ni ping du healthcheck.
    Motif : la photo du jour porte un indice de croissance qui se rechaîne sur
    lui-même, et un `DRY_RUN` qui en poserait une casserait la chaîne du run
    réel ; le ping, lui, dirait à updown.io qu'un run a conclu alors que le run
    du jour n'a pas eu lieu.
17. `core/risk.ts` **ne connaît pas le mode**. Aucune signature publique
    n'expose de paramètre `dryRun`, `force` ou `bypass` : le test de contrat de
    `risk.ts` le vérifie déjà et reste vert.

**L'exécution — l'étape 6 du §8**

18. L'étape 6 place les jambes de la **stratégie active uniquement**.
    `rebalance_ab`, `ladder` et `dca` n'en placent aucune, quel que soit leur
    verdict. Sonde : un run où les quatre stratégies rendent `ACCEPTED` ne
    produit d'ordres que pour `rebalance`.
19. Les ordres sont **limit post-only exclusivement**. Le drapeau est du type
    `true` : `false` ne compile pas, comme il ne compile déjà pas dans
    `liquidate.ts`.
20. Le prix limite vaut **mid ± 0,1 %**, du côté qui ne croise pas le carnet :
    sous le mid à l'achat, au-dessus à la vente. Le signe est testé, pas
    seulement l'écart.
21. Le `client_order_id` vient de `src/core/order-id.ts` et de nulle part
    ailleurs. Aucun module d'exécution n'en fabrique un.
22. La paire est **exclusivement en USDC**. `quote: 'EUR'` ne compile pas.
23. **L'ordre est écrit en base avant d'être placé.** Un job interrompu entre
    l'écriture et le placement laisse une ligne `PENDING` que la réconciliation
    du lendemain sait rattraper ; un job interrompu après un placement non écrit
    laisse un ordre que rien ne réclame.
24. **Rejouer le run du même jour ne place aucun second ordre.** Deux lignes de
    défense, testées séparément : l'index unique
    `(run_date, strategy, is_shadow)` de `decisions`, et le `client_order_id` en
    clé primaire d'`orders`. Le §8 exige de ne pas dépendre d'une seule.
25. **`max retries = 0`** sur la définition du job Scaleway, vérifiable dans la
    définition déployée. La relecture de R3 le protège déjà.
26. Un rééquilibrage **partiellement exécuté n'est pas compensé dans la foulée**
    : aucun chemin de l'étape 6 ne replace une jambe rejetée ou non exécutée
    dans le même run. Le run suivant relit les poids réels et recalcule.
27. L'alerte **`REBALANCE_EXECUTED`** est émise quand des ordres partent, avec
    le compte placé et le compte exécuté. Le champ `executed` d'`alertInputOf`
    cesse d'être vide en dur.
28. Le **rapport quotidien** distingue ordres placés, exécutés, partiels et non
    exécutés, et cite les frais réels. Un rapport qui ne dirait pas ce qui est
    parti serait un rapport d'observation dans une phase d'exécution.

**Le plafond réduit (B2), clos par O1 = 3, O2 = 3 et O3 = 3**

Les trois décisions se referment l'une sur l'autre : le plafond **est**
`REBALANCE_TOO_LARGE_PCT` abaissé, il refuse le run entier au lieu de raboter,
et il se lève par un commit. Le mécanisme de rejet et l'alerte existent depuis
la phase 0 ; **le motif journalisé, lui, n'existait pas** — le cadrage l'avait
supposé sans le vérifier, la revue du lot l'a infirmé, et E32 le décrit tel
qu'il est désormais. Sont donc neufs : la valeur, et le motif lisible écrit
dans `decisions.reason`.

29. Un plafond réduit est **armé dès le premier run qui exécute**, et il est
    strictement plus contraignant que `REBALANCE_TOO_LARGE_PCT` à 25 %.
    **O1 = 3** : le plafond est une **fraction de la valeur du portefeuille par
    run**, donc `REBALANCE_TOO_LARGE_PCT` lui-même, abaissé à **8 %**. Cette
    valeur est **mesurée, pas estimée** : sur 974 jours de rejeu, les douze
    rééquilibrages de production pesaient de 5,0 à 10,7 %, et un simple retour
    à la cible depuis la bande cash 24–36 % en déplace déjà ~6 %. À 5 %, valeur
    avancée par le cadrage sans données, 594 jours de déclenchement étaient
    refusés et 3 rééquilibrages sur 12 passaient — le mois calendaire d'E56
    serait devenu un mois d'alertes `URGENT` quotidiennes sans rien d'armé. À
    8 %, 166 jours sont refusés et 10 rééquilibrages passent : le plafond mord
    sans neutraliser la phase. Aucune règle nouvelle n'est écrite : c'est la valeur d'une constante
    existante qui change, et le lot qui l'abaisse est fusionné **avant** celui
    qui arme l'exécution. Le plafond s'applique donc à tout appel de
    `validate()`, verdicts shadow compris — voir E31.
30. Le plafond est une **constante du code**, au même endroit que les autres
    seuils de risque, avec ses tests. Aucune variable d'environnement ne le
    change : `src/config/env.ts` fait déjà échouer le démarrage sur toute
    variable préfixée `UBAC_RISK_`, et ce critère ne rouvre pas cette porte.
    S'il vit dans `core/risk.ts`, le seuil de couverture à 100 % lignes et
    branches s'applique.
31. Le plafond s'applique à la **stratégie active et à elle seule**. Il ne
    s'applique pas à la sortie propre : une liquidation n'est pas un
    rééquilibrage, et les seuils qui gouvernent l'un ne gouvernent pas l'autre —
    même raisonnement que E48. Précision rendue nécessaire par O1 = 3 :
    le critère porte sur l'**effet** — quelles jambes sont empêchées de partir —
    et non sur les verdicts prononcés. `validate()` étant appelée pour les
    quatre stratégies, les ombres verront elles aussi davantage de
    `REBALANCE_TOO_LARGE` ; elles ne placent rien, donc le plafond n'a sur elles
    aucun effet. Un plafond par stratégie donnerait à la couche risque un
    paramètre de plus, ce qu'E30 refuse.
32. Un run empêché par le plafond **n'est jamais silencieux** : le motif est
    journalisé dans `decisions` en texte lisible, et une alerte part. **O2 = 3** :
    le comportement est le **refus du run entier**, jamais le rabotage — le
    portefeuille reste hors bande jusqu'à la levée du plafond, et l'alerte part
    chaque jour où il le reste. Le cadrage avait tenu ce critère pour
    **acquis** depuis la phase 0 et Q6a2, sans le vérifier. La revue du lot du
    plafond l'a infirmé : le rejet `REBALANCE_TOO_LARGE` et l'alerte du même
    nom existaient, mais `decisions.reason` ne recevait que le motif de
    l'intention — le texte du rejet n'atteignait que l'alerte, et
    `risk_verdict` n'en porte que le code. Le lot du plafond l'a satisfait :
    la colonne garde le motif de l'intention en tête et y ajoute une ligne par
    rejet, son code et son motif quantifié. Cela vaut pour toute décision
    refusée, des quatre stratégies et quel que soit le code.
33. **Sans objet, clos par O2 = 3.** Ce critère exigeait qu'un run raboté
    n'arme pas le cooldown. Le rabotage ayant été écarté, aucun run
    volontairement incomplet n'existe, `armsCooldown` n'a rien à distinguer, et
    `core/risk.ts` n'est pas touchée sur ce point. Le numéro est conservé sans
    exigence pour que E34 à E58 ne se décalent pas : ils sont cités ailleurs
    dans le dépôt.
34. La **levée du plafond est tracée** : la date et le geste qui l'ont produite
    sont lisibles après coup, de sorte qu'on puisse dire quel run a été le
    premier à pleine taille. **O3 = 3** : le geste est le **changement de la
    constante dans le code**, en PR relue et déployée — donc un commit de
    `main`, daté et signé, et la trace **est** l'historique du dépôt. Aucun
    mécanisme n'a à l'enregistrer. Le run qui suit le déploiement est le premier
    à pleine taille, et son `git_sha` dans `decisions` le rattache au commit.
    Ni levée automatique, ni variable d'environnement : `src/config/env.ts` fait
    déjà échouer le démarrage sur toute variable préfixée `UBAC_RISK_`, et ce
    critère ne rouvre pas cette porte.

**Réconciliation : les écritures que la phase 3 ouvre**

35. Tout ordre limit non exécuté de **plus de 24 h est annulé** (§7, point 3).
    L'horloge est un **paramètre de `ReconcileInput`** : `src/jobs/reconcile.ts`
    n'en lit aucune, et le garde-fou de pureté de `test/jobs/` le tient —
    `src/jobs/` étant hors du glob de pureté d'`eslint.config.js`.
36. L'annulation est **idempotente** : annuler un ordre déjà dénoué n'est pas
    une erreur du run. Sonde : l'annulation est demandée deux fois de suite sur
    le même ordre.
37. Le **statut réel d'un ordre donné** et ses exécutions sont lisibles par
    l'adapter. Le statut `INDETERMINABLE` de `ReconciledOrderStatus` cesse
    d'être atteignable pour un ordre que l'exchange connaît. C'est la lecture
    que `docs/reconciliation.md` §4 pose en prérequis.
38. Les transitions d'ordres calculées depuis Q4a sont **persistées** dans
    `orders` : `status`, `filled_qty`, `filled_price`, `fees`, `settled_at`.
39. La **base de l'écart** et le **seuil de 1 %** ne changent pas, et
    `test/jobs/reconcile-accord-risque.test.ts` continue d'exiger que le job et
    `core/risk.ts` rendent le même verdict sur la même table de cas.

**Le cooldown, alimenté pour de vrai**

40. `lastCompleteRebalanceOn` vient de la **base**, par `cooldownAnchor`
    appliqué à l'historique des exécutions. Le littéral `null` de
    `src/jobs/daily.ts` disparaît. `armsCooldown` et `cooldownAnchor` ne
    changent pas : ils sont déjà écrits, testés et couverts à 100 %. **La nuance
    du §7 est donc implémentée dans le noyau depuis la phase 0 ; ce qui manque
    est son alimentation, pas la règle.**
41. Le cooldown ne s'arme que sur un rééquilibrage **complet réussi**. Sonde de
    bout en bout : un run partiellement exécuté à J n'empêche pas le run de J+1
    de recalculer et de placer.
42. Le cooldown de B reste **distinct de celui de A** (C12 de la phase 0), et le
    gel de 7 jours après un apport ne gèle pas B (C25 et C26 de la phase 0). Ces
    critères restent verts.

**La sortie propre, armée (B5)**

43. `appliquerSortie` **applique**. Le type `SortieVerrouillee` et
    `test/jobs/liquidate-verrou.test.ts` sont **retirés** dans le lot qui arme
    la sortie, pas laissés verts à vide : « le verrou ne se lève pas, il se
    retire ».
44. La sortie a sa **commande CLI**, un second point d'entrée composant les
    adapters. `test/jobs/purete.test.ts` (A20, A22) est **étendu pour l'admettre
    nommément**, jamais désarmé : deux composeurs énumérés valent mieux qu'un
    garde-fou supprimé.
45. La sortie reçoit son **domaine propre dans `src/core/order-id.ts`**, et
    `DECALAGE_DE_JAMBE` disparaît. Sonde : une sortie et un run quotidien du
    même jour, sur le même actif et le même côté, produisent deux
    `client_order_id` différents.
46. La sortie **relit les soldes et les ordres ouverts avant d'appliquer**, dans
    la même passe que son plan. `docs/sortie-propre.md` §5 le pose déjà comme la
    charge de l'exécuteur de phase 3.
47. L'annulation précède la cession : la quantité cédée inclut le gelé, ce qui
    n'est correct que dans cet ordre. **O7 = 2** : la **désactivation du
    déclencheur passe en premier**, avant l'annulation. L'ordre livré est donc
    `DECLENCHEUR, ANNULATION, CESSION, RAPPORT`, et `ETAPES` de
    `src/jobs/liquidate.ts` le dit, avec le test qui confronte le plan à ce
    tableau. C'est un **écart assumé avec le §14**, dont l'étape 3 désactive le
    cron après les cessions ; le motif est la fenêtre de `docs/sortie-propre.md`
    §5, théorique tant que rien ne s'exécute et réelle dès que cette spec arme
    les deux chemins. Le rapport entre l'annulation et la cession, lui, ne
    change pas.
48. `core/risk.ts` **n'est pas appelée** par la sortie et **n'est pas
    assouplie** pour elle. Les invariants qui s'appliquent vraiment —
    contrepartie USDC, limit post-only, plancher `MIN_LEG_USDC`,
    `client_order_id` déterministe — sont repris nommément, comme aujourd'hui.
49. Le **rapport final** de la sortie est marqué `REALISE` et porte les cessions
    réellement exécutées, leurs frais et les résidus. Le `PROJETE` d'aujourd'hui
    ne survit pas à l'armement.

**Non négociables, revérifiés sur le code livré**

50. `src/core/` reste **pur** : aucune IO, aucune horloge système, aucun accès à
    l'environnement, aucun aléatoire. Le port d'exécution vit dans
    `src/adapters/`, son appelant dans `src/jobs/`. Les règles de lint de `core`
    ne bougent pas d'un octet.
51. Aucun **`number` flottant** sur un prix, une quantité, un montant ou un
    poids dans le code livré par cette phase — y compris à la frontière de
    l'adapter d'exécution : une taille d'ordre ou un frais renvoyé par Coinbase
    entre par la même porte que les soldes, `decimal.js` obligatoire.
52. **Aucun secret en clair** dans le dépôt, dans un journal, dans un message
    d'erreur, ni dans une notification ntfy.
53. `core/risk.ts` reste couvert à **100 % lignes et branches**, seuil bloquant
    dans la configuration Vitest et désormais porté par la chaîne (R1).
54. Chaque lot tient sous **1 000 lignes ajoutées + supprimées**, fixtures
    générées et lockfiles exclus, avec leur volume et leur validation documentés
    séparément.
55. Toute vérification passe par **Docker Compose** : `make ci`,
    `make typecheck`, `make test`, `make coverage`. Aucun `node` ni `npm` sur le
    poste.

**Sortie de la phase 3**

56. **O4 = 1** : la phase 3 est close par **un mois calendaire de runs armés
    sans incident**, même si aucun rééquilibrage n'a eu lieu. Le compte part du
    premier run qui exécute à plein — c'est-à-dire après la levée du plafond
    (E34) — et « sans incident » signifie : aucun abandon de run, aucun ordre
    resté `INDETERMINABLE`, aucune alerte `URGENT` non expliquée. La sortie de
    phase est **prononcée explicitement** dans Orca, jamais déduite du
    calendrier : une phase qui se termine parce qu'un mois s'est écoulé se
    termine sans que personne n'ait regardé.
57. À la sortie, E1 à E55 — ainsi qu'E59 et E60, ajoutés plus bas — sont tenus
    et vérifiés **sur `main`**, pas sur une branche en vol. E33 est exclu de ce
    compte : il est sans objet depuis O2 = 3.
58. La phase 3 **ne conclut rien sur la stratégie**. Aucun résultat de
    performance, aucune comparaison au DCA ou au hold, n'est un critère de
    sortie. C'est la même règle qu'en phase 0, et elle vaut d'autant plus ici
    que les chiffres seront cette fois réels — donc convaincants, et tout aussi
    peu significatifs sur un mois.

**Ajoutés par les réponses O5 et O6, à la suite et sans renuméroter**

Ces deux critères ne pouvaient pas s'écrire avant les réponses : l'un décrit un
mécanisme qui n'existe pas encore (`Alert` n'a aucun champ d'action), l'autre un
état qui n'existe pas encore (le jour de resynchronisation arrive avec la
PR #45). Ils sont numérotés à la suite plutôt qu'insérés dans leur section
thématique, pour que E1 à E58 continuent de désigner la même chose partout où
ils sont cités.

59. **Le bouton ntfy de la sortie propre est de type `view`** (O5 = 1) : il
    ouvre la console Scaleway, et l'opérateur y lance le job de sortie à la
    main. **Aucun jeton, aucune URL signée, aucun secret ne voyage dans une
    notification** — ce qui vaut d'autant plus que le canal est public tant
    qu'E3 n'est pas tenu. Le type `Alert` gagne un champ d'action, `notifier.ts`
    le rend dans la charge utile ntfy, et la relecture d'alerte — celle qui
    refuse une alerte illisible plutôt que de publier un objet douteux — valide
    ce champ comme elle valide les cinq autres. Une alerte sans action reste une
    alerte valide : le champ est facultatif, et seule l'alerte de sortie le
    porte.
60. **Un jour de resynchronisation refuse d'exécuter** (O6 = 1) : le run
    journalise, écrit ses décisions et sa photo, et **ne place aucun ordre**.
    Le refus est explicite et porte son motif, jamais une omission — c'est le
    mot de `docs/reconciliation.md` §3 bis, et il est juste. Ce critère
    **n'a d'objet qu'une fois la PR #45 fusionnée** : sans elle, une divergence
    au-delà de 1 % abandonne le run avant toute décision, donc aucun jour de
    resynchronisation n'existe et rien ne peut exécuter ce jour-là. Si #45 est
    fermée sans être fusionnée, E60 disparaît avec elle et le comportement
    d'abandon le tient trivialement.

## Zones d'incertitude assumées

- **Le scoping au portefeuille ne couvre pas les endpoints v2, et la question du
  trade n'est pas tranchée.** `docs/cle-coinbase.md` l'a mesuré le 2026-09-11 :
  `/v2/accounts` rend le compte entier avec une clé scopée sur `ubac-agent`. La
  question qui y est laissée ouverte — « si une clé reçoit `can_trade`, les
  endpoints v2 échappent-ils aussi au scoping pour les ordres ? » — **n'est
  toujours pas tranchée**, et elle doit l'être avant l'armement. Ne pas supposer
  que non. Le dépôt ne peut pas y répondre seul : c'est une mesure à faire sur
  la nouvelle clé.
- **Une phase 3 peut se terminer sans aucun rééquilibrage.** 4 à 8
  déclenchements par an, et une jambe post-only peut ne jamais s'exécuter. C'est
  le même avertissement que le §13 donne déjà pour la phase 1, et il vaut ici :
  ne pas resserrer les bandes pour « voir quelque chose ».
- **La phase 3 ne démontre rien sur la valeur de la stratégie.** Le §5.6 pose
  que battre le DCA sur 12 mois est la condition de justification. Un mois de
  rééquilibrages réels n'en dit rien.
- **Les frais réels ne sont pas connus.** Le §5.5 raisonne sur 0,25 % maker. Le
  statut maker dépend du volume, et un portefeuille de cette taille n'est
  probablement pas au meilleur palier. L'écart se lira dans les `fees` de la
  table `orders` ; c'est une observation de la phase 3, pas un critère.
- **La méthode de PRU n'est toujours pas tranchée**, et la phase 3 produit les
  premières cessions réelles. L'export fiscal reste hors périmètre, mais
  l'horloge tourne : les données nécessaires à n'importe quelle méthode doivent
  être dans `orders` dès le premier ordre, sans quoi elles seront perdues. C'est
  ce que couvre E38.
- **Le retour en arrière n'a pas de procédure écrite** tant que la décision D12
  de la phase 2 n'est pas tranchée. Armer l'exécution sur une chaîne dont le
  retour en arrière n'est écrit nulle part laisse l'opérateur sans autre recours
  que la console Scaleway.
- **Les vingt tests de base ne tournent pas en CI** (D2 de la phase 2). L'index
  unique de `decisions`, c'est-à-dire la garantie d'idempotence du run, n'est
  pas couvert par la porte. En phase 3, cette idempotence protège de l'ordre
  double : le trou est déclaré, il n'est pas comblé.
