# Intégration continue

La porte du dépôt, exécutée par GitHub Actions. Spec §10, sous-section GitHub
Actions ; lot **R1** de la phase 2 (`docs/plans/ubac-phase-2.md`). Ce document
dit ce que la porte fait, ce que l'opérateur doit cocher dans la console pour
qu'elle bloque réellement, et ce qu'elle **ne** garantit **pas**.

À ce stade, la chaîne n'a qu'un job : `test`. `build` (R2) et `deploy` (R3)
n'existent pas encore, et la production tourne toujours sur l'image déployée à
la main (`docs/deploiement.md`).

## 1. Ce que la porte exécute

Un seul workflow, `.github/workflows/ci.yml`, un seul job, `test`, sur
`ubuntu-24.04` :

```sh
npm ci
npm run typecheck
npm run test:coverage
```

**La couverture, et non `npm test`.** `test:coverage` rejoue toute la suite *et*
fait respecter les 100 % lignes, branches, fonctions et instructions de
`src/core/risk.ts` (`vitest.config.ts`), que le §10 nomme explicitement.
Exécuter les deux paierait la suite deux fois ; n'exécuter que `npm test`
donnerait une garantie strictement plus faible. Le seuil cesse d'être une
commande que quelqu'un pense à lancer : il devient une porte automatique.

Autour de ces trois commandes :

| Réglage | Valeur | Pourquoi |
|---|---|---|
| Jeton | `permissions: contents: read` | dépôt public, et la suite fait tourner le code de toutes ses dépendances ; le défaut du dépôt est plus large |
| Checkout | `persist-credentials: false` | le jeton ne reste pas dans `.git/config`, où n'importe quel test pourrait le lire |
| Secrets | aucun | la porte n'en a besoin d'aucun, et n'en voit aucun |
| Concurrence | groupe par référence ; annulation **sur les PR seulement** | une rafale de poussées sur une PR ne fait tourner que la dernière ; sur `main`, rien n'est interrompu en cours de route, car le même workflow poussera une image à partir de R2 |
| Runner | `ubuntu-24.04`, épinglé | aucune étiquette mouvante nulle part dans un workflow, runner compris |
| Délai du job | 15 min | un processus bloqué ne garde pas un contrôle requis en attente six heures |
| Cache | `cache: npm` de `actions/setup-node` | voir les limites, §6 |

### Les déclencheurs : « chaque poussée qui peut atteindre `main` »

La porte tourne sur `pull_request` vers `main` et sur `push` sur `main`. « Chaque
poussée » se lit **chaque poussée qui peut atteindre `main`** : une branche sans
PR n'est pas testée, délibérément, parce qu'elle n'est pas fusionnable — un
auteur découvre l'échec en ouvrant sa PR plutôt qu'en poussant, ce qui est une
minute de retard, pas un trou.

Le `push` sur `main` n'est pas le déclencheur de confort. Il teste le **commit de
squash**, qu'aucune PR n'a testé tel quel : la PR testait sa tête de branche, et
la fusion en squash produit un objet différent, sur une base qui a pu bouger
entre-temps. Sans lui, `main` serait le seul endroit du dépôt dont aucun test ne
garantit l'état.

Le choix inverse — `push` sur toutes les branches, plus `pull_request` — ferait
tourner la suite **deux fois** à chaque poussée sur une branche de PR, avec deux
contrôles `test` sur le même SHA : une page de PR ambiguë, pas un dépôt plus sûr.
Décision du coordinateur au lot R1, le 2026-09-22.

## 2. Deux définitions de « comment on teste »

La décision **D1** (`actions/setup-node` + `npm ci`) est rapide, et elle crée
une seconde définition de la façon de tester, à côté du `Makefile` et de
Compose :

| | Poste | Chaîne |
|---|---|---|
| Node | `Dockerfile` : `node:22-bookworm` | `actions/setup-node`, `node-version: '22'` |
| Installation | `make ci` → `npm ci` dans le conteneur | `npm ci` sur le runner |
| Porte | `make typecheck`, `make coverage` | `npm run typecheck`, `npm run test:coverage` |

C'est un coût assumé, et c'est au garde-fou de le rendre visible : une
divergence rougit **sur le poste**, pas six mois plus tard.

## 3. Le garde-fou : `test/ci/workflow.test.ts`

Il fait partie de `make test`. Il lit les workflows, `package.json`, les deux
`Dockerfile` et les seuils de `vitest.config.ts`, et tient treize règles :

| Règle | Ce qu'elle refuse |
|---|---|
| Le contrôle requis s'appelle `test` | un job renommé, ou un `name:` affiché différent — la protection de `main` épingle le contrôle **par son nom** : le renommer la désarme sans que rien ne rougisse |
| La porte exécute la couverture | toute autre suite que `npm ci`, `npm run typecheck`, `npm run test:coverage`, dans cet ordre — donc `npm test` à la place, ou en plus |
| La couverture mord | un script `test:coverage` qui n'est plus `vitest run --coverage`, ou un seuil de `risk.ts` sous 100 % |
| Scripts déclarés | un `npm run` vers un script absent de `package.json`, un `npx`, un `npm` autre que `ci` et `run` |
| Node aligné | un `node-version` hors de `engines.node`, non épinglé à un majeur, ou d'un autre majeur que les deux `Dockerfile` |
| `needs` | un `build` sans `needs: test`, un `deploy` sans `needs: build`, et tout job qui ne dépend pas, même indirectement, de `test` |
| Porte inconditionnelle | un `if:` sur le job ou l'une de ses étapes — un contrôle requis **sauté compte comme réussi** —, ou un `continue-on-error` |
| Aucun `latest` | la chaîne `latest` sur n'importe quelle ligne, commentaires compris |
| Aucune migration | `drizzle-kit`, `db-push` ou `db:push` sur n'importe quelle ligne (`docs/base-de-donnees.md` §5) |
| Secrets | une clé qui nomme un identifiant (`*SECRET*`, `*TOKEN*`, `*PASSWORD*`, `*_KEY`…) dont la valeur n'est pas exactement `${{ secrets.NOM }}` ; et tout `secrets.` dans le job `test` |
| Déclencheurs | autre chose que `push` et `pull_request` vers `main` — `pull_request_target` compris |
| Jeton | des permissions effectives du job `test` autres que `contents: read` |
| Concurrence | un groupe sans `github.ref`, ou une annulation inconditionnelle qui interromprait `main` |

Chaque règle a au moins une **sonde** : une mutation du dépôt réel, appliquée
en mémoire, qui doit la faire rougir. Vingt-sept sondes, dont les quatre
mutations exigées par le plan — retirer `needs: test`, remplacer la couverture
par `npm test`, écrire `drizzle-kit` dans un workflow, faire diverger la version
de Node. `build` et `deploy` n'existant pas encore, les sondes de `needs`
ajoutent la chaîne complète du §10 au workflow réel, puis la cassent ; un test
constate que cette chaîne complète, intacte, passe toutes les règles.

Le garde-fou lit **ce que les fichiers disent**, pas ce que GitHub exécute : voir
les limites.

## 4. La marge des délais, mesurée sur le runner

`test/budget-reporter.ts` fait rougir le run au-delà de 80 % du délai propre d'un
test (`docs/marge-des-delais.md`). Le plan de la phase 2 attendait le pire cas
sur le rejeu — 9 542 ms sur 30 000 au poste, 31,8 % — et demandait de **mesurer
d'abord sur le runner**. Trois exécutions de la porte, sur `ubuntu-24.04`, le
2026-09-22, tableau du reporter abaissé temporairement à 5 % pour tout voir :

| Test (`test/`) | Délai | Run 1 | Run 2 | Run 3 | Pire |
|---|---:|---:|---:|---:|---:|
| `jobs/purete.test.ts` > A3 | 5 000 | 2 419 | 3 650 | 1 971 | **73 %** |
| `replay/report.test.ts` > fige les six séries | 30 000 | 7 648 | 15 082 | 7 504 | 50 % |
| `jobs/purete.test.ts` > A25 | 5 000 | 888 | 1 779 | 824 | 36 % |
| `jobs/purete.test.ts` > A24 | 5 000 | 953 | 1 758 | 1 186 | 35 % |
| `structure.test.ts` > C1, frontière de couche | 5 000 | 744 | 1 540 | — | 31 % |
| `replay/engine.test.ts` > six séries C29 | 30 000 | 4 995 | 9 084 | 4 878 | 30 % |
| Durée totale de vitest | | 30,2 s | 56,1 s | 29,6 s | |

Deux constats.

1. **Le pire test n'est pas celui qu'on attendait.** Sur le runner, le rejeu est
   plus rapide qu'au poste ; c'est **A3**, qui linte `src/jobs/` sept fois sous
   un délai de 5 s, qui s'effondre : 1,3 s au poste, jusqu'à 3,65 s sur le runner.
   À 73 %, il est à un facteur 1,1 de faire rougir la porte.
2. **Le runner est bruité** : le run 2 a duré 1,9 fois le run 1, sur le même
   commit.

Remède, selon la règle et sans la renégocier : un **délai ciblé de 30 s sur A3
seul**, comme celui d'A22 dans le même fichier, avec son motif écrit dans le
test. A4, dans le même bloc, reste à 5 s. Le `testTimeout` global n'est pas
touché.

MESURES_APRES

## 5. D3 — ce que l'opérateur coche dans la console

**D3** : protéger `main`, `test` en contrôle requis, **sans revue requise**.
C'est un geste de console, pas une ligne de code : aucun test ne peut le
vérifier. À poser **après** le premier passage vert de la PR R1 — GitHub ne
propose un contrôle dans la liste qu'une fois qu'il a tourné — et **avant** son
merge.

*Settings → Branches → Add classic branch protection rule* (ou un *ruleset*
équivalent) :

| Case | État | Motif |
|---|---|---|
| Branch name pattern : `main` | ☑ | |
| **Require status checks to pass before merging** | ☑ | le cœur de D3 |
| → contrôle **`test`**, source **GitHub Actions** | ☑ | le nom du job ; le garde-fou l'épingle |
| → Require branches to be up to date before merging | ☐ | le `push` sur `main` teste déjà le commit de squash ; cocher forcerait un rebase et une nouvelle exécution après chaque merge |
| Require a pull request before merging → Require approvals | ☐ | D3 : sans revue requise, l'opérateur est seul |
| **Do not allow bypassing the above settings** | ☑ | sans elle, l'administrateur — l'opérateur — garde un bouton « merge without waiting for requirements », et « une PR dont un test échoue ne peut pas être fusionnée » cesse d'être vrai |

Vérification, depuis le poste :

```sh
gh api repos/olaurendeau/ubac/branches/main/protection \
  --jq '{checks: [.required_status_checks.checks[].context], admins: .enforce_admins.enabled}'
# attendu : {"checks":["test"],"admins":true}
```

Le critère « une PR dont un test échoue ne peut pas être fusionnée » se
constate une fois, après D3 : une PR brouillon dont un test échoue exprès, dont
le bouton de merge reste bloqué et que `gh pr merge` refuse, puis fermée sans
merge.

## 6. Ce que la porte ne garantit pas

- **Elle ne couvre pas la base** (D2). Les 23 tests qui parlent à Postgres —
  19 dans `test/adapters/db.test.ts`, 4 dans
  `test/adapters/schema-contraintes.test.ts` — sont ignorés en silence sur le
  runner, faute d'`UBAC_TEST_DATABASE_URL`. **L'index unique, c'est-à-dire la
  garantie d'idempotence du run quotidien, n'est pas couvert par la porte.**
  `make test-db` reste une porte du poste. Une pastille verte ne dit rien de la
  base.
- **Elle lit des fichiers, pas GitHub.** Le garde-fou ne voit ni un contrôle
  requis retiré dans les réglages, ni la case de contournement décochée. D3 est
  invérifiable par un test ; seule la commande du §5 le constate.
- **Les actions tierces ne sont pas épinglées par SHA** (D6) :
  `actions/checkout@v7` et `actions/setup-node@v7` sont des étiquettes majeures,
  dont le contenu peut changer sous la chaîne. Risque accepté, pas ignoré — il
  pèsera davantage quand la chaîne détiendra une clé de déploiement (R2).
- **Le cache npm** est restauré depuis le cache d'Actions. Pour un job qui ne
  fait que lire le code et ne voit aucun secret, un cache empoisonné ne peut
  rien voler. `actions/setup-node` recommande de s'en passer dans un job à
  privilèges : R2 et R3 doivent reposer la question, pas hériter de la réponse.
- **Node est aligné au majeur, pas au correctif.** Le runner prend le dernier
  22.x de son cache (22.23.2 le 2026-09-22), le poste celui de son image
  `node:22-bookworm` au moment où elle a été construite.
- **Une branche sans PR n'est pas testée** : voir §1, c'est voulu.
- **Le runner est partagé et bruité** (§4). Le garde-fou de marge rend un
  ralentissement visible, il ne le supprime pas : un run deux fois plus lent que
  le pire mesuré ici ferait encore rougir un test à 5 s au-delà de 40 %.
