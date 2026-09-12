# Run quotidien

`src/jobs/daily-main.ts` est le point d'entrée exécutable du run quotidien de la
spec §8. Il ne contient **que la composition** : il lit ses arguments, charge la
configuration, ouvre les adaptateurs, appelle `runDaily` de `src/jobs/daily.ts`
et ferme ce qu'il a ouvert. Toute la logique est dans `daily.ts`, qui ne connaît
des adaptateurs que leurs types.

Lots Q4b1, Q4b1-bis et Q4b2 de la phase 1. La réconciliation qu'il appelle est décrite dans
[reconciliation.md](reconciliation.md) ; les frontières de la phase sont dans
[phase-1-frontieres.md](phase-1-frontieres.md).

## 1. Lancer le job

```sh
npm run daily -- --git-sha="$(git rev-parse --verify HEAD)"
```

Le script `daily` de `package.json` fabrique les dates, l'opérateur fournit le
SHA :

```
AT=$(date -u +%FT%TZ); tsx src/jobs/daily-main.ts --run-date=${AT%T*} --at=$AT
```

**Un seul appel à `date`**, et les deux valeurs en sortent. Deux appels
séparés — un pour `--run-date`, un pour `--at` — auraient laissé une fenêtre
d'une milliseconde à minuit UTC où le jour de run et l'instant journalisé
tombent de part et d'autre de la limite.

Rejouer un jour précis, ou fournir l'instant soi-même :

```sh
npm run daily -- --run-date=2026-09-01 --git-sha=<sha>
npm run daily -- --run-date=2026-09-01 --at=2026-09-01T06:00:00Z --git-sha=<sha>
```

`npm` ajoute les arguments qui suivent `--` **après** ceux du script, et la
dernière occurrence d'une option gagne : c'est ce qui permet de remplacer un
défaut sans avoir à deviner l'ordre.

### Les trois arguments

| Argument | Requis | Rôle |
|---|---|---|
| `--run-date=YYYY-MM-DD` | oui | jour UTC du run. Clé de `decisions` avec la stratégie. |
| `--git-sha=<sha>` | oui | code qui tourne, journalisé dans `decisions.git_sha`. |
| `--at=<instant ISO>` | non | `decisions.created_at` ; par défaut `00:00:00Z` du jour de run. |

**Aucun n'a de valeur de repli dans le code.** `--run-date` et `--git-sha` absents
arrêtent le programme avec le mode d'emploi, et une valeur vide vaut absente —
un `--git-sha=$GIT_SHA` dont la variable n'est pas posée échoue au lieu
d'écrire une chaîne vide. Un `unknown` journalisé dans `decisions.git_sha`
coûterait exactement ce que la colonne existe pour éviter : savoir quel code a
pris une décision douteuse.

`--at` n'est pas contraint au jour de run : un rejeu du 2026-09-01 lancé
aujourd'hui porte légitimement un `created_at` d'aujourd'hui. C'est `run_date`
qui est la clé, et elle est passée à part.

### Codes de sortie

| Code | Signification |
|---|---|
| 0 | le run a conclu — `COMPLETED`, les quatre lignes de `decisions` écrites ou déjà présentes, et la photo du jour prise ou déjà prise. |
| 1 | tout le reste : arguments refusés, configuration invalide, abandon de réconciliation, erreur. |

Un abandon de réconciliation rend **1**. Ce n'est pas une anomalie du programme,
mais ce n'est pas un succès : le déclencheur extérieur doit le voir rouge.

## 2. La configuration entre par `src/config/env.ts`, et par lui seul

Les six variables du §10 sont requises et sans défaut : `DATABASE_URL`,
`COINBASE_API_KEY`, `COINBASE_API_SECRET`, `BREVO_API_KEY`, `NTFY_TOKEN`,
`HEALTHCHECK_URL`. Une absente arrête le démarrage, et le message **nomme la
variable sans jamais citer sa valeur** — `DATABASE_URL` porte un mot de passe, et
un message d'erreur finit dans un journal.

Le point d'entrée ne lit **jamais** `process.env`. Il appelle `loadConfig()`, et
c'est tout : `test/jobs/purete.test.ts` (A13, A14, A18) refuse toute mention de
la globale `process` dans `src/jobs/`, sauf `argv`, `exitCode`, `stdout` et
`stderr`. Le contourner ferait sauter en une ligne la validation des secrets, le
refus du préfixe `UBAC_RISK_` et le filtre des littéraux décimaux.

Aucune variable `UBAC_RISK_*` n'est acceptée : les seuils de risque vivent dans
`src/core/risk.ts`, couverts à 100 %, et n'ont pas de mode de contournement.

## 3. Ce que le run fait : les étapes 1 à 5 et 7

1. **Healthcheck de démarrage.** La clé répond, et le run dit ce qu'il est.
2. **Réconciliation**, avant toute décision. Un abandon arrête le run **avant la
   première écriture**.
3. **Soldes réels et prix du dernier jour clos.** La fenêtre OHLCV s'arrête au
   dernier jour **clos** : la bougie du jour en cours est partielle et bouge d'un
   appel au suivant.
4. **Poids constatés**, et flux de trésorerie assez récents pour geler le
   déclencheur A.
5. **Les quatre stratégies** — `rebalance`, `rebalance_ab`, `ladder`, `dca` —
   décidées, validées par la couche risque, puis journalisées. Une ligne par
   stratégie et par run, `trigger NONE` comprise : un run sans action laisse une
   trace.
7. **Benchmarks et photo du jour** dans `snapshots` : valeur totale, poids,
   positions, benchmarks. Détail ci-dessous.

L'étape 7 est **calculée avant l'étape 5** et **écrite après**. Calculée avant,
parce que la suspension au drawdown est une entrée de la décision et ne peut pas
attendre. Écrite après, parce que c'est ce qui donne gratuitement la propriété
que la spec attend d'un abandon : **un run abandonné n'écrit aucune photo**,
puisqu'il rend avant d'y arriver.

L'idempotence de `decisions` vient de la base : aucune condition du code ne
vérifie qu'un run a déjà eu lieu, c'est l'index unique
`(run_date, strategy, is_shadow)` qui refuse la seconde écriture en rendant
`ALREADY_RECORDED`. Celle de `snapshots` ne peut pas venir du même endroit : sa
clé primaire **remplace** la ligne du jour au lieu de la refuser. C'est la règle
d'antériorité de la section 4 qui la tient. Relancer le même `--run-date` reste
sans danger.

### Ce qu'un abandon laisse, et ce qu'il ne laisse pas

Un abandon — divergence de réconciliation, portefeuille non valorisable,
stratégie indécidable — **n'écrit rien du tout** : ni décision, ni photo. C'est
volontaire : le run s'arrête avant la première écriture, et rien de partiel ne
reste derrière lui.

La conséquence est à connaître : **depuis la base, un abandon est
indistinguable d'un job qui n'a pas tourné.** Les deux laissent la journée vide.
Le cas s'est produit en réel sur le compte de l'opérateur — portefeuille vide,
valeur totale nulle, aucun poids définissable, run abandonné proprement, aucune
ligne écrite. La spec prévoit qu'un abandon déclenche une **alerte** (§9) et
c'est l'alerte, pas la base, qui fera la différence ; elle arrive au lot suivant.
D'ici là, la seule trace d'un abandon est le journal du processus et son code de
sortie **1**.

### La photo du jour, le drawdown et la suspension du §6

`src/jobs/snapshot.ts` calcule l'étape 7 ; son en-tête porte les motifs, cette
section porte ce qu'un opérateur doit en savoir.

**Les benchmarks sont consommés, pas recalculés.** Les métriques de
`src/core/benchmark.ts`, livrées en phase 0, sont appelées telles quelles sur la
fenêtre OHLCV de 200 jours : TWR, max drawdown et Sharpe glissant 90 j du hold
BTC et du hold 50/50. Les deux hold partent d'**1 USDC sans flux**, le TWR étant
invariant d'échelle. Les courbes d'ombre `ladder` et `dca` que cite le §4 **ne
sont pas écrites** : en phase 1 aucune stratégie ne place d'ordre, donc les trois
portefeuilles simulés seraient le portefeuille réel au centime près, et trois
courbes identiques feraient lire une comparaison là où il n'y en a aucune.

**Le drawdown se mesure sur l'indice de croissance, jamais sur la valeur en
USDC** — un retrait de la moitié du portefeuille creuse la valeur de 50 % sans
qu'aucun prix n'ait bougé. La fenêtre est l'historique **entier**, depuis la
première photo. La source est **la série des snapshots passés**, condensée :
chaque photo porte dans `benchmarks` l'indice (`portfolio_twr_index`) et son
plus-haut (`portfolio_twr_peak`), et la suivante s'y enchaîne.

**La photo du jour se prend une fois.** Un second run le même jour ne la réécrit
pas : il relit le drawdown qu'elle porte, donc il suspend exactement comme le
premier. Un rejeu d'un jour antérieur à une photo existante ne réécrit rien non
plus. Le motif est dans l'en-tête du module : le plus-haut est idempotent,
l'indice ne l'est pas.

**Le premier run n'a pas de drawdown, et n'écrit pas zéro à la place.** La clé
`portfolio_drawdown` est **absente** de `benchmarks`, et son absence est ce qui
enregistre l'indisponibilité — un zéro se lirait « tout va bien » et ce serait
faux. Conséquence : **un drawdown indisponible ne suspend pas**, la règle disant
« un drawdown de 25 % suspend » et inconnu n'étant pas 25 %.

**La suspension porte sur la seule stratégie de production.** Au-delà de -25 %
— borne **incluse**, le §6 disant « de 25 % » et non « de plus de 25 % » —
`decide()` n'est pas appelé pour la production, et sa ligne de `decisions` porte
`trigger NONE`, zéro jambe et une `reason` préfixée `SUSPENSION_DRAWDOWN` avec le
chiffre. Sans ce marqueur, un jour suspendu serait indistinguable d'un jour où
rien n'a déclenché. Les trois stratégies d'ombre continuent d'être
journalisées : elles ne passent aucun ordre, donc les suspendre ne protégerait
rien et couperait la comparaison au moment où elle est la plus intéressante.
Aucune vente n'est déclenchée : la décision de sortir reste humaine (§6).

### Une conséquence pour la réconciliation

À partir de ce lot, chaque run réussi **rafraîchit le cache** que la
réconciliation du lendemain compare aux soldes réels. Avant, `snapshots` n'était
alimentée par personne. La limite décrite dans
[reconciliation.md](reconciliation.md) section 6 — un apport de plus de 1 % de la
ligne USDC survenu entre deux runs fait abandonner le run — devient donc une
limite d'un jour et non d'une durée indéfinie : le run suivant l'abandon reste
bloqué, mais la photo la plus récente date bien de la veille dès qu'un run
aboutit.

## 4. Ce que le run ne fait pas

**L'étape 6, l'exécution, n'existe pas.** Ce n'est pas une étape laissée vide ni
désarmée par un drapeau : aucun code de placement n'est écrit, et le garde-fou de
noms d'`eslint.config.js` refuse dans `src/adapters/` et `src/jobs/` tout nom qui
dénote un placement, une annulation ou un retrait. La clé Coinbase est en lecture
seule.

Les étapes 8 et 9 — rapport Brevo et ping du healthcheck — appartiennent aux lots
suivants et ne sont pas appelées ici. `runDaily` rend sa fenêtre OHLCV, ses
benchmarks et son drawdown tels quels pour qu'ils les consomment.

### L'annulation des ordres de plus de 24 h est reportée en phase 3

L'étape 3 du §7 — « annuler tout ordre limit non exécuté datant de plus de 24 h »
— **n'est pas implémentée, même désarmée**. C'est une décision de l'opérateur
(D2), pas un oubli, et elle est détaillée dans
[reconciliation.md](reconciliation.md) section 3. Le résumé :

- en phase 1 aucun ordre n'est jamais placé, donc aucun ordre ne peut avoir plus
  de 24 h ; la branche serait du code mort, non testable sur des données réelles ;
- écrire un appel d'annulation contredirait le garde-fou de phase cité ci-dessus ;
- la clé est en lecture seule, donc le chemin ne serait de toute façon pas
  testable de bout en bout.

Conséquence pour ce point d'entrée : **rien ici ne dépend d'une durée**. `--at`
n'est pas comparé à l'âge d'un ordre, et la réconciliation n'a pas d'horloge du
tout. Le jour où l'étape 3 arrive, c'est `ReconcileInput` qui reçoit une horloge
injectée ; l'ajouter aujourd'hui donnerait un paramètre que le prochain lecteur
croirait utile.

## 5. Pourquoi le job n'a pas d'horloge

Rien dans `src/jobs/` ne lit l'heure. `run_date` et l'instant journalisé entrent
par la ligne de commande, et `test/jobs/purete.test.ts` (A5, A7) refuse
`Date.now()`, `new Date()` sans argument, `Math.random()`, `crypto` et
`performance` dans tout le répertoire.

La raison est l'idempotence, pas le style : un run lancé à 23 h 59 UTC et son
rejeu à 00 h 01 porteraient deux `run_date` différentes, et l'index unique de
`decisions` ne protégerait plus de rien. L'horloge est donc **visible**, dans une
ligne de shell qu'on peut lire, plutôt que cachée dans un appel.

## 6. Pourquoi rien n'importe ce fichier

`daily-main.ts` est le **seul** fichier de `src/jobs/` qui importe un adaptateur
en valeur, donc le seul qui charge `ccxt` et `pg`. C'est ce qui laisse `daily.ts`
testable contre des doubles, sans réseau ni clé ni base.

Cette exception tient à une seule chose : **rien ne l'importe**. Le module appelle
son `main` à l'évaluation, donc un `import` depuis une suite de tests ne ferait
pas seulement entrer deux paquets — il lancerait le run. `test/jobs/purete.test.ts`
tient les deux moitiés :

- **A20** — l'arbre réel de `src/jobs/` ne contient qu'**un** fichier où la règle
  parle, et c'est celui-là, nommé. Un second lieu de composition, ou un
  adaptateur glissé dans `daily.ts`, échoue.
- **A22** — les onze formes d'import qui le feraient entrer tombent, sur tout le
  TypeScript du dépôt : `src/`, `test/` et les fichiers de configuration de la
  racine.

A22 refuse les **imports**, pas un chemin passé à un sous-processus — c'est la
façon prévue de le lancer, et c'est ainsi que `test/jobs/daily-main.test.ts`
éprouve son contrat d'arguments. Conséquence assumée : ce fichier apparaît à
**0 %** dans le rapport de couverture, l'instrumentation v8 du parent ne voyant
pas le processus fils. Son comportement est éprouvé, son chiffre de couverture ne
le dit pas ; le déplacer pour faire monter le chiffre coûterait la garantie.

## 7. Vérifier

```sh
make check      # npm ci + typecheck + test
make coverage   # même chose, avec le seuil de 100 % sur src/core/risk.ts
```

Aucun test n'ouvre de connexion : `test/jobs/daily-main.test.ts` fabrique
l'environnement du sous-processus, réduit à `PATH`, de sorte que `loadConfig()`
refuse avant qu'aucun adaptateur n'ouvre quoi que ce soit. Vérifié sous réseau
coupé — `docker compose run` n'a pas de drapeau `--network`, donc la vérification
passe par `docker run` directement :

```sh
docker run --rm --network none -v "$PWD":/workspace \
  -v ubac-q4b1-run_ubac_node_modules:/workspace/node_modules \
  -w /workspace ubac-q4b1-run-dev npm test
```
