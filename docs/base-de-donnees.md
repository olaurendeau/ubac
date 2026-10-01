# Base de données

Lot Q2. Schéma Postgres du §4 de la spec, base de développement locale,
commande de migration, et l'adapter qui lit et écrit.

Livré en deux fois : **Q2a** a posé le schéma et la base, **Q2b** ajoute
`src/adapters/db.ts` et ses opérations.

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

Les quatre tables du §4, et le journal du convoyeur. Le DDL réellement
appliqué est celui qu'affiche `make db-push` ; `src/adapters/schema.ts` en est
la seule source.

| Table | Clé | Ce qu'elle porte |
|---|---|---|
| `decisions` | `id` uuid, **index unique `(run_date, strategy, is_shadow)`** | journal immuable de chaque run, runs sans action compris |
| `orders` | `client_order_id` | ordres placés et leurs transitions |
| `snapshots` | `run_date` | photo quotidienne : valeur, poids, positions, benchmarks |
| `cash_flows` | `id` uuid, **index unique `natural_key`** | apports (positif) et retraits (négatif), avec leur origine |
| `convoyeur_journal` | `id` uuid, **index unique `(convoyage, step)`** et **un `ACHAT_DEMANDE` par `day`** | les étapes de chaque convoyage, en ajout seul |

### `cash_flows` : origine et clé naturelle (DC7 du convoyeur)

- `origin` vaut `OPERATEUR` (**défaut**), `CONVOYEUR` ou `DETECTE` (réservée au
  flux que l'exchange révélera, N8 du plan des flux ; personne ne l'écrit). Le
  défaut garde passant l'`INSERT` que l'opérateur tape aujourd'hui, et donne aux
  lignes déjà saisies l'origine qui est la leur. Une origine hors liste est
  refusée par la base (`cash_flows_origin_check`) **et** à la lecture
  (`cashFlowOriginFromText`, comme `side`).
- `natural_key` est nulle pour une saisie de l'opérateur, et obligatoire pour
  une ligne `CONVOYEUR` (`cash_flows_convoyeur_natural_key_check`). Son index
  unique, `cash_flows_natural_key_key`, est ce qui rend l'écriture du convoyeur
  idempotente : la seconde bute en `23505` sur ce nom, sans lecture préalable.
  La clé ne remplace pas `id`, qui reste la clé primaire.

### `convoyeur_journal` : une ligne par étape, écrite avant l'appel

Étapes : `ACHAT_DEMANDE`, `ACHETE`, `TRANSFERT_DEMANDE`, `TRANSFERE`,
`ENREGISTRE`, `EN_PANNE`. L'état d'un convoyage est sa dernière étape ; une
étape déjà écrite bute sur `convoyeur_journal_convoyage_step_key`, et un second
convoyage ouvert le même jour UTC sur `convoyeur_journal_day_key` (index
partiel sur `ACHAT_DEMANDE`) : « un passage, un convoyage » (DC8) est une
propriété de la base. Les colonnes de grandeur (`amount_usdc`, `debited_eur`,
`fees_eur`) sont des `numeric(20, 8)`, nulles aux étapes qui ne les portent pas.
`convoyage` porte le `client_order_id` du convoyage, dérivé de `day` ;
`debited_eur` vaut `filled_value + total_fees` (Y4a).

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
Postgres renvoie dans le champ `constraint` : l'adapter s'en sert pour
distinguer « déjà enregistré » de n'importe quelle autre erreur d'écriture
(§6).

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

**Comment on l'établit**, et pas seulement on l'affirme :

1. **Aller-retour contre la vraie base** avec des valeurs qu'aucun double ne
   porte : `12345678901.12345678` vaut `12345678901.123457` en IEEE-754, et
   `0.00000001` est le dernier chiffre significatif de la colonne. Le test
   compare les chaînes, pas les valeurs approchées. Un flottant n'importe où sur
   le trajet change les chiffres et le test tombe.
2. **Le driver est interrogé directement**, hors adapter : un `SELECT` par un
   client `pg` nu vérifie que `total_value_usdc` arrive en `string`.
3. **Le contenu `jsonb` est relu en texte brut** (`weights::text`) et comparé
   caractère pour caractère : les feuilles sont des chaînes entre guillemets, pas
   des nombres JSON.
4. **La forme de la spec est rejouée et refusée** : un `UPDATE` qui repose
   `{"BTC":0.47}` dans la colonne fait échouer `latestSnapshot()`. La frontière
   mord sur des données qu'elle n'a pas écrites elle-même.
5. **Un `number` passé à `decimalFromText` est refusé**, y compris exact.
6. **Un balayage du code livré** interdit `parseFloat`, `parseInt`, `Number(`,
   `.toNumber(`, `.valueOf(`, `z.number` et `mode: 'number'` dans
   `src/adapters/*.ts`. Contrôle de noms, du même statut que le garde-fou C32 :
   utile, tenu, et explicitement pas une démonstration — ce sont les points 1 à 5
   qui démontrent.

Les points 1 à 4 demandent la base et tournent dans `make test-db`. Les points 5
et 6 tournent dans `make test`, sans base : la règle non négociable ne doit pas
dépendre d'une suite qu'on peut oublier de lancer.

### Ce qui reste en `Date` et en `number`, volontairement

`created_at`, `occurred_at` et `settled_at` sont des instants, pas des grandeurs
de marché : ils circulent en `Date`. `run_date` reste une **chaîne**
`YYYY-MM-DD` : la convertir en `Date` lui donnerait minuit dans le fuseau du
processus, donc un décalage d'un jour à l'ouest de Greenwich. Le noyau raisonne
en `IsoDate` depuis la phase 0, et ce sont des **jours UTC** : le point d'entrée
fabrique `run_date` par `date -u`. Le déclencheur, lui, tire à 07:00
`Europe/Paris` (spec §8), soit 05:00 UTC l'été et 06:00 UTC l'hiver : toujours
après la clôture des bougies daily à 00:00 UTC, et toujours dans le même jour
UTC que le jour de Paris.

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

### Pourquoi les cibles de base passent `--no-file-parallelism`

Deux fichiers de test parlent à la base — le schéma d'un côté, l'adapter de
l'autre — et **ils partagent une seule base**, que chacun vide dans son
`beforeEach`. Lancés en parallèle, ils se tronquent mutuellement les tables sous
les pieds : des échecs intermittents, jamais les mêmes, qui n'ont rien à voir
avec ce que les tests vérifient.

`--no-file-parallelism` sérialise les fichiers pour ces cibles seulement.
Vitest garde son parallélisme partout ailleurs : `make test` et `make coverage`
ne sont pas ralentis. C'est le prix d'une base unique, et il se paie en
millisecondes ; isoler chaque fichier dans son propre schéma Postgres coûterait
plus de machinerie que la suite n'en vaut aujourd'hui.

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

### Le rôle du convoyeur : rejouer le script après chaque `push`

Le convoyeur écrit sous son propre rôle, `ubac_convoyeur` (Q9) : `INSERT` sur
`cash_flows`, `SELECT` et `INSERT` sur `convoyeur_journal`, rien d'autre — ni
`SELECT` sur `cash_flows`, ni `UPDATE`, ni `DELETE`, ni `CREATE`, ni table
temporaire. **Ces droits ne sont pas dans le schéma** : `drizzle-kit push` ne
connaît pas les `GRANT`, et un `push` qui recrée une table les efface. Ils
vivent dans `scripts/role-convoyeur.sql`, idempotent, sans mot de passe, qui
se rejoue **après tout `push` qui touche `cash_flows` ou le journal** :

```sh
docker compose run --rm --no-deps -e DATABASE_URL -v "$PWD/scripts:/scripts:ro" \
  db sh -c 'psql "$DATABASE_URL" -f /scripts/role-convoyeur.sql'
```

Le `psql` est celui de l'image `db` : le poste n'en a pas. Le script retire ce
que `PUBLIC` donne à tout rôle (tables, séquences, `EXECUTE` sur les fonctions,
`CREATE` sur `public`, `TEMPORARY` sur la base), y compris pour ce qu'un `push`
futur créerait (`ALTER DEFAULT PRIVILEGES` du propriétaire des tables, **sous sa
forme globale** : Postgres accorde `EXECUTE` à `PUBLIC` par un défaut global,
qu'un défaut par schéma ne peut pas retirer). `CONNECT` reste à `PUBLIC`. Ces
`REVOKE` valent pour toute la base : le propriétaire des tables garde ses droits
de propriétaire. La sonde CV19, `test/adapters/role-convoyeur.test.ts`, tourne
sous `make test-db` et éprouve le rôle par `SET ROLE`.

**Deux limites constatées de `push`**, sur la base locale, le 2026-09-28 :

- **Pas de RLS hors du schéma.** Une politique « le rôle n'écrit que des lignes
  `CONVOYEUR` positives » posée en SQL est retirée au `push` suivant
  (`DISABLE ROW LEVEL SECURITY`, `DROP POLICY`), sans question. Elle n'est donc
  pas retenue : le rôle est borné par ses `GRANT` et par les contraintes.
- **Une contrainte `CHECK` modifiée sous le même nom n'est pas vue** (« No
  changes detected »). Changer le corps d'une contrainte exige de la renommer ;
  en retirer une, en revanche, est bien appliqué.

### Le type SQL s'écrit `numeric(20, 8)`, avec l'espace

C'est sous cette forme que `drizzle-kit` relit la colonne depuis la base. Écrit
sans espace, le type déclaré et le type introspecté ne se ressemblent plus :
chaque `push` ré-émet un `ALTER COLUMN … SET DATA TYPE` sur les sept colonnes
numériques — du bruit sur une base jetable, une réécriture de table sous verrou
exclusif sur la base réelle.

**L'espace n'est donc pas une coquette de formatage, et le retirer n'est pas un
nettoyage.** `src/adapters/schema.ts` l'écrit tel quel dans `dataType()`, et un
test sans base verrouille la chaîne exacte.

---

## 6. L'adapter : des opérations, pas un client

`src/adapters/db.ts` n'expose jamais le client. `openDatabase(secrets)` rend une
`UbacDatabase` dont la surface est la liste complète de ce que le programme sait
faire de sa base :

| Opération | Ce qu'elle fait |
|---|---|
| `recordDecision(input)` | journalise la décision du jour ; `ALREADY_RECORDED` si la base la refuse |
| `recordSnapshot(input)` | pose la photo du jour ; rejouer le même jour la **remplace** |
| `latestSnapshot()` | la photo la plus récente, ou `undefined` |
| `recentCashFlows(since)` | les flux depuis un instant, du plus ancien au plus récent |
| `pendingOrders()` | les ordres non dénoués, ordonnés par date de création |
| `close()` | ferme le pool |

Les noms disent l'usage, pas la table. Ajouter une opération est une décision ;
ouvrir un client brut n'en serait pas une.

`openDatabase` prend `Pick<Secrets, 'databaseUrl'>` : le type dit d'où la valeur
vient. **L'adapter ne lit jamais l'environnement** — `src/config/env.ts` reste le
seul point de lecture du code qui tourne, et le job passe la valeur déjà validée.

Décision immuable, photo remplaçable : c'est la seule asymétrie du module. Une
décision engagée ne se réécrit pas ; une photo du jour, recalculée avec les prix
du moment, si.

### Le refus de la base, traduit une fois et une seule

`recordDecision()` insère sans lecture préalable. Postgres lève `23505`,
l'adapter le traduit en `ALREADY_RECORDED`, qui n'est pas une erreur mais le cas
nominal d'un second run. Que la base refuse est établi en §2, sans passer par du
code à nous ; ce qui se joue ici est la traduction.

Elle est **étroite**, et c'est ce que le test contrôle : le nom de l'index est
vérifié, pas seulement le code. Un `23505` sur une autre contrainte remonte, et
une erreur d'écriture d'une autre nature aussi — la rendre en `ALREADY_RECORDED`
ferait croire au job que sa décision est enregistrée alors qu'aucune ligne
n'existe.

### Ce que l'adapter d'Ubac n'écrit pas

**Aucune écriture de `cash_flows`.** Les flux sont saisis par l'opérateur, et
l'apport automatique est écrit par le convoyeur, sous son propre rôle et hors
de `UbacDatabase`. L'exchange ne donne pas d'identifiant de transfert (S7 du
convoyeur) : la clé naturelle du convoyeur est dérivée de son ordre d'achat,
`CONVOYEUR:<client_order_id>`. Un écrivain sans clé naturelle ne serait pas
idempotent — un rejeu doublerait l'apport et fausserait le time-weighted return.
Les lectures (`recentCashFlows`, `latestDeposits`) rendent l'origine de chaque
ligne ; le noyau ne la lit pas. Les tests alimentent la table en SQL direct.

### La base du convoyeur : trois opérations, sous son rôle

`src/convoyeur/base.ts` est le pendant de `db.ts` pour le convoyeur, et le seul
fichier de son arbre qui importe `drizzle-orm` et `pg` (`eslint.config.js`).
`openConvoyeurBase({ databaseUrl })` se connecte avec la chaîne du rôle
`ubac_convoyeur` et rend une `ConvoyeurBase` :

| Opération | Ce qu'elle fait |
|---|---|
| `dernierConvoyage()` | les lignes du jour le plus récent du journal, lues en leur étape la plus avancée (`EN_PANNE` clôt le passage, `ENREGISTRE` clôt tout, panne comprise : [convoyeur.md](convoyeur.md) §8) ; `undefined` si le journal est vide |
| `ecrireEtape(etape)` | ajoute une ligne au journal ; `ALREADY_RECORDED` sur `convoyeur_journal_convoyage_step_key` ou `convoyeur_journal_day_key` |
| `ecrireApport(apport)` | ajoute la ligne `cash_flows` du convoyage ; `ALREADY_RECORDED` sur `cash_flows_natural_key_key` |
| `close()` | ferme le pool |

Rien n'y demande plus que Q9 : ni `UPDATE`, ni `DELETE`, ni `RETURNING` (qui
exigerait `SELECT` sur `cash_flows`), ni lecture de l'apport avant de l'écrire.
L'apport porte l'origine `CONVOYEUR`, la clé `CONVOYEUR:<client_order_id>`, pour
montant `filled_size` (DC4), pour instant celui du transfert (DC5), et pour note
l'EUR débité, les frais et l'identifiant d'ordre de l'exchange. Un montant nul,
négatif ou à plus de 8 décimales est refusé avant l'écriture : la colonne
l'arrondirait sans le dire. Un journal dont les lignes du dernier jour mêlent
deux convoyages, ou dont une étape manque d'une grandeur, est refusé à la
lecture (`ConvoyeurBaseError`) plutôt que lu.

Les tests de base (`test/convoyeur/base.test.ts`) ouvrent le port **sous le
rôle**, par l'option de connexion `-c role=ubac_convoyeur` (le rôle n'a pas de
mot de passe en local), et éprouvent le même contrat sur le double du passage
(`test/convoyeur/doubles.ts`).

---

## 7. Ce qui changera en phase 2 avec Neon

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
