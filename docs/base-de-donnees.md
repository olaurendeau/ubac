# Base de données

Lot Q2. Schéma Postgres du §4 de la spec, base de développement locale,
commande de migration, puis l'adapter qui lit et écrit.

Le lot est livré en deux fois : **Q2a** pose le schéma et la base — ce document
en l'état — et **Q2b** ajoute `src/adapters/db.ts`, ses opérations et les
preuves d'aller-retour, avec les sections de ce document qui les décrivent.

Références : `docs/specs/ubac-rebalance.md` §3, §4 et §10 ;
`docs/plans/ubac-phase-1.md`, lot Q2 ; décision préalable **D5**.

---

## 1. Décision D5 : Postgres local, Neon en phase 2

La base de développement est un **Postgres jetable lancé par Docker Compose**.
Neon reste la cible de la phase 2. Rien dans ce lot n'en dépend :

- pas de `@neondatabase/serverless`, pas de driver HTTP, pas de WebSocket ;
  l'adapter parle à `pg` (node-postgres) sur TCP, ce que la chaîne *pooled* de
  Neon accepte telle quelle ;
- la chaîne de connexion est une variable d'environnement, validée par
  `src/config/env.ts` (`DATABASE_URL`, protocole `postgres://` ou
  `postgresql://`) ;
- `sslmode=require`, que Neon impose, est lu par `pg` depuis la chaîne : rien à
  changer dans le code.

---

## 2. Le schéma

Quatre tables, conformes au SQL du §4. Le DDL réellement appliqué est celui
qu'affiche `make db-push` ; `src/adapters/schema.ts` en est la seule source.

| Table | Clé | Ce qu'elle porte |
|---|---|---|
| `decisions` | `id` uuid, **index unique `(run_date, strategy, is_shadow)`** | journal immuable de chaque run, runs sans action compris |
| `orders` | `client_order_id` | ordres ; vide en phase 1, rien n'est placé |
| `snapshots` | `run_date` | photo quotidienne : valeur, poids, positions, benchmarks |
| `cash_flows` | `id` uuid | apports (positif) et retraits (négatif) |

### L'index unique est la garantie d'idempotence

`CREATE UNIQUE INDEX decisions_run_date_strategy_is_shadow_key ON decisions
(run_date, strategy, is_shadow)`.

Un second run le même jour ne peut pas produire une seconde décision, et le
refus vient de **la base**. Le journal n'a donc pas besoin d'être relu avant
d'être écrit : une lecture préalable laisserait entre le `select` et l'`insert`
exactement la fenêtre par laquelle une double décision passerait.

C'est éprouvé sur un vrai Postgres, **sans passer par du code à nous**
(`test/adapters/schema-contraintes.test.ts`) : un client `pg` nu insère deux
fois la même clé, la base répond `23505` en nommant l'index, et le même jour
reste ouvert à une autre stratégie et au shadow. Une démonstration qui
emprunterait l'adapter ne prouverait que l'adapter.

Le nom de l'index est figé et exporté par `schema.ts`, parce que c'est lui que
Postgres renvoie dans le champ `constraint` : l'adapter de Q2b s'en sert pour
distinguer « déjà enregistré » de n'importe quelle autre erreur d'écriture.

### Divergence assumée avec l'exemple du §4 : les grandeurs `jsonb`

Un seul écart, dans les colonnes `jsonb`, et il est **volontaire**. Le §4 écrit
`weights_before {BTC: 0.47, ETH: 0.28, USDC: 0.25}`. En JSON, `0.47` est un
double IEEE-754 et `JSON.parse` le rend en `number` : le flottant que tout le
noyau évite depuis la phase 0 rentrerait par le journal, en contradiction avec
la règle non négociable d'`AGENTS.md`.

Les grandeurs sont donc stockées en **chaînes décimales** :
`{"BTC":"0.47","ETH":"0.28","USDC":"0.25"}`. Les clés, le sens des valeurs et le
type de colonne restent ceux de la spec ; seule la représentation du nombre
change, parce que celle de la spec perd de la précision. Le `jsonb` n'a pas de
schéma déclaré : rien d'autre n'en dépend.

`docs/specs/ubac-rebalance.md` n'est **pas** modifié. L'exemple du §4 y reste tel
quel : aligner la spec sur ce choix est une décision de l'opérateur, pas un
ajustement technique de ce lot. La divergence est signalée ici, elle n'est pas
tranchée ici.

Deux ajouts, sans retrait : `legs` porte aussi `quote` et `limitPrice` — ce
qu'aurait été l'ordre, pas seulement son montant — et `risk_verdict` est typé
`'ACCEPTED' | 'REJECTED:<code>'` côté TypeScript plutôt que laissé à une
convention. Sur un rejet multiple, seul le premier code est retenu, comme la
colonne le prévoit ; le détail lisible va dans `reason`.

---

## 3. Le piège : `numeric(20,8)` revient en chaîne

C'est une bonne chose, et c'est ce sur quoi tient toute la frontière.

**Sens lecture.** `decimalFromText()` (`src/adapters/schema.ts`) est le seul
chemin d'entrée d'une grandeur. Il refuse ce qui n'est pas une chaîne — un
driver reconfiguré, une colonne relue autrement — et refuse aussi une chaîne qui
n'est pas une décimale littérale. `decimal.js` accepte `NaN`, `Infinity` et
`0x10`, et Postgres sait **stocker** `'NaN'` dans un `numeric` : un poids `NaN`
relu ne déclencherait aucun seuil, puisque `Decimal.gt` et `Decimal.lt`
répondent tous les deux `false` dessus. Même motif et même raison que
`src/config/env.ts`.

**Sens écriture.** `textFromDecimal()` sérialise par `Decimal.toFixed()`, sans
argument : notation normale complète, jamais d'exposant — Postgres refuserait
`1e-8` sur un `numeric` — et aucun flottant intermédiaire. Une grandeur non
finie est refusée avant d'atteindre la base. L'arrondi à huit décimales est
laissé à la colonne, qui en est la définition ; ce qui dépasse
`numeric(20,8)` fait échouer l'insertion côté base plutôt que d'être arrondi en
silence.

**Ce qui l'établit** — l'aller-retour contre la vraie base, la relecture du
`jsonb` en texte brut, le balayage du code livré — arrive avec l'adapter, en
Q2b : ce sont ses opérations qui font le trajet complet. Ici, la frontière est
posée et décrite ; elle n'est pas encore empruntée.

### Ce qui reste en `Date` et en `number`, volontairement

`created_at`, `occurred_at` et `settled_at` sont des instants, pas des grandeurs
de marché : ils circulent en `Date`. `run_date` reste une **chaîne**
`YYYY-MM-DD` : la convertir en `Date` lui donnerait minuit dans le fuseau du
processus, donc un décalage d'un jour à l'ouest de Greenwich. Le noyau raisonne
en `IsoDate` depuis la phase 0, et le cron tourne en UTC (§8).

---

## 4. Lancer la base en local

```sh
make db-up        # démarre Postgres et attend qu'il soit sain
make db-push      # applique le schéma, DEPUIS LE POSTE
make test-db      # suite complète, tests de base compris
make db-shell     # psql dans le conteneur, pour regarder
make db-down      # arrête la base, garde les données
make clean        # supprime les volumes, données Postgres comprises
```

Identifiants : `ubac_dev` / `developpement-sans-secret`, base `ubac_dev`. Ce ne
sont pas des secrets, et leur nom le dit : Postgres n'écoute que sur le réseau
Compose — aucun port n'est publié sur le Mac — et la base ne contient aucune
donnée réelle. La vraie `DATABASE_URL` n'est jamais dans le dépôt.

### Pourquoi `./scripts/dev.sh` ne suffisait pas

Le wrapper lance `docker compose run --rm --no-deps dev …`. Le `--no-deps`
empêche Compose de démarrer les dépendances : un test lancé par ce wrapper ne
peut pas joindre la base, quel que soit le `depends_on` déclaré.

Trois voies étaient possibles : retirer `--no-deps` du wrapper, ce qui aurait
fait démarrer Postgres à chaque `make typecheck` ; poser la chaîne de connexion
partout et laisser les tests échouer sans base ; ou séparer les commandes.

**C'est la troisième qui est retenue**, et le wrapper n'est pas modifié :

- `make ci`, `make typecheck`, `make test`, `make coverage` passent par
  `./scripts/dev.sh`, gardent `--no-deps` et se comportent **exactement comme
  avant**. Aucune base n'est démarrée, aucune connexion n'est ouverte ;
- `make db-push`, `make test-db`, `make coverage-db` appellent
  `docker compose run --rm dev` sans `--no-deps`, ce qui honore le
  `depends_on: db: condition: service_healthy` et attend que Postgres réponde.

Les tests qui ont besoin de la base sont ignorés — pas en échec — tant que
`UBAC_TEST_DATABASE_URL` n'est pas posée. `make test` les affiche comme
`skipped`, ce qui est visible plutôt que silencieux.

### Pourquoi `UBAC_TEST_DATABASE_URL` et pas `DATABASE_URL`

Si la suite lisait `DATABASE_URL`, un poste où la vraie chaîne est exportée
verrait ses tests faire un `TRUNCATE` sur des tables de production. La variable
de test est distincte, et aucune commande de ce dépôt ne la pose ailleurs que
sur la base jetable de Compose. Elle n'est pas lue par `src/config/env.ts` :
c'est une variable de suite de tests, pas de configuration, et elle n'a donc pas
sa place dans `.env.example`.

---

## 5. Migrations : depuis le poste, jamais depuis un job, un script ou une CI

> ### ⚠ `drizzle-kit push` exécute ses instructions destructrices sans demander
>
> Vérifié sur la base locale de ce dépôt : une table absente du schéma a été
> listée sous un `Warning  You are about to execute current statements:`, puis
> supprimée par un `DROP TABLE … CASCADE`. **Aucune question n'a été posée.**
> La confirmation n'apparaît que sur un terminal interactif ; lancée sans TTY —
> depuis un job, un script, un runner de CI — la commande enchaîne l'avertissement
> et l'exécution, et le seul témoin est une ligne de log que personne ne lit.
>
> **La règle, et son motif.** Le §3 de la spec dit déjà « depuis le poste, jamais
> depuis le job ». Ce n'est pas une convention d'organisation : c'est une
> protection contre une **perte de données silencieuse**. Sur la base réelle, le
> schéma porte le journal immuable des décisions ; un `push` non surveillé peut
> le supprimer pour la seule raison qu'un fichier TypeScript a bougé.
>
> `make db-push` ne tourne donc **que depuis le poste**, sur un terminal, avec le
> SQL sous les yeux. Jamais depuis un job, jamais depuis un script automatisé,
> jamais depuis une CI.

```sh
make db-push
# équivaut à, dans le conteneur dev :
#   DATABASE_URL="$UBAC_DEV_DATABASE_URL" npx drizzle-kit push --verbose
```

`drizzle-kit push` compare `src/adapters/schema.ts` à la base vivante et
applique la différence. `--verbose` affiche le SQL exécuté : c'est ce qui rend
l'opération relisible, à défaut d'un fichier de migration. Aucun fichier n'est
produit ni versionné.

### Ce qui tient la règle

**Structurellement**, le job ne peut pas migrer : `drizzle-kit` est une
`devDependency`, `drizzle.config.ts` n'est lu que par l'outil, et l'adapter
n'expose aucune opération de schéma. Un job capable de modifier le schéma de sa
base est un job capable de la casser à 7 h du matin, seul, sans témoin.

**Un garde-fou, modeste et nommé comme tel** : `make db-push` refuse de partir si
la variable `CI` est posée, ce que font tous les runners courants. Il attrape
l'accident le plus probable — la cible recopiée dans un workflow — et rien
d'autre. Il ne protège pas d'un script qui ne pose pas `CI`, ni d'un `npm run
db:push` appelé directement : la garantie reste la règle ci-dessus, pas ce test.

### Le type SQL s'écrit `numeric(20, 8)`, avec l'espace

C'est sous cette forme que `drizzle-kit` relit la colonne depuis la base. Écrit
sans espace, le type déclaré et le type introspecté ne se ressemblent plus :
chaque `push` ré-émet un `ALTER COLUMN … SET DATA TYPE` sur les sept colonnes
numériques — du bruit sur une base jetable, une réécriture de table sous verrou
exclusif sur la base réelle.

**L'espace n'est donc pas une coquette de formatage, et le retirer n'est pas un
nettoyage.** `src/adapters/schema.ts` l'écrit tel quel dans `dataType()`, et un
test sans base verrouille la chaîne exacte (il arrive avec Q2b).

---

## 6. Ce qui changera en phase 2 avec Neon

- **Création du projet Neon** en AWS eu-central-1 (Francfort) — la région par
  défaut est aux États-Unis — et chaîne *pooled* posée en variable secrète
  Scaleway. Aucun changement de code : `pg` s'y connecte comme ici.
- **`DATABASE_URL` cesse d'être une valeur de développement.** `make db-push`
  vise la base locale ; pousser vers Neon se fait en posant la vraie chaîne dans
  l'environnement, depuis le poste, jamais depuis le job ni depuis la CI.
- **Le mécanisme de migration mérite d'être rediscuté.** `push` convient à une
  base jetable qu'on peut recréer ; sur une base qui porte l'historique réel des
  décisions, une migration SQL générée (`drizzle-kit generate`), relue et
  versionnée avant application vaut mieux qu'une différence calculée à
  l'exécution. Ce n'est pas ce que la spec §3 retient aujourd'hui : à trancher
  au moment où la base cesse d'être jetable.
- **L'auto-suspend de Neon** réveille la base au premier `connect`, quelques
  centaines de millisecondes. Sans importance pour un job quotidien, mais le
  `max: 2` du pool est là pour ça : un job séquentiel de cinq minutes n'a pas
  besoin de dix connexions sur une base serverless.
- **Le Postgres de Compose reste**, pour le développement et les tests. Aucune
  suite ne doit dépendre d'une base distante.
