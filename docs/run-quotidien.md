# Run quotidien

`src/jobs/daily-main.ts` est le point d'entrée exécutable du run quotidien de la
spec §8. Il ne contient **que la composition** : il lit ses arguments, charge la
configuration, ouvre les adaptateurs, appelle `runDaily` de `src/jobs/daily.ts`
et ferme ce qu'il a ouvert. Toute la logique est dans `daily.ts`, qui ne connaît
des adaptateurs que leurs types.

Lot Q4b1-bis de la phase 1. La réconciliation qu'il appelle est décrite dans
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
| 0 | le run a conclu — `COMPLETED`, les quatre lignes de `decisions` écrites ou déjà présentes. |
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

## 3. Ce que le run fait : les étapes 1 à 5

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

L'idempotence vient de la base : aucune condition du code ne vérifie qu'un run a
déjà eu lieu, c'est l'index unique `(run_date, strategy, is_shadow)` qui refuse
la seconde écriture en rendant `ALREADY_RECORDED`. Relancer le même
`--run-date` est donc sans danger.

## 4. Ce que le run ne fait pas

**L'étape 6, l'exécution, n'existe pas.** Ce n'est pas une étape laissée vide ni
désarmée par un drapeau : aucun code de placement n'est écrit, et le garde-fou de
noms d'`eslint.config.js` refuse dans `src/adapters/` et `src/jobs/` tout nom qui
dénote un placement, une annulation ou un retrait. La clé Coinbase est en lecture
seule.

Les étapes suivantes appartiennent aux lots suivants et ne sont pas appelées
ici : le snapshot quotidien (7), les benchmarks, le rapport et le ping (8 et 9).
`runDaily` rend sa fenêtre OHLCV telle quelle pour qu'ils la consomment.

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
