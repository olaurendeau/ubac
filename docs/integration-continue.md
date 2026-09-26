# Intégration continue

La porte du dépôt et l'image de production, exécutées par GitHub Actions.
Spec §10, sous-section GitHub Actions ; lots **R1** et **R2** de la phase 2
(`docs/plans/ubac-phase-2.md`). Ce document dit ce que la chaîne fait, ce que
l'opérateur doit cocher dans la console pour qu'elle bloque réellement, et ce
qu'elle **ne** garantit **pas**.

À ce stade, la chaîne a deux jobs : `test`, puis `build` qui pousse l'image
(§7). `deploy` (R3) n'existe pas encore : **rien ne change en production**, qui
tourne toujours sur l'image déployée à la main (`docs/deploiement.md`).

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

La porte tourne sur `pull_request` vers `main`, sur `push` sur `main` et sur les
tags `v*` — ces derniers pour `build` (§7), que `test` précède. « Chaque
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
`Dockerfile` et les seuils de `vitest.config.ts`, et tient dix-sept règles :

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
| Déclencheurs | autre chose que `push` sur `main` et les tags `v*`, et `pull_request` vers `main` — `pull_request_target` compris |
| Jeton | des permissions effectives d'un job autres que `contents: read` |
| Image par les scripts | un `build` sans `./scripts/build-image.sh`, puis `./scripts/verifier-image.sh`, puis `docker push`, dans cet ordre ; ou qui construit, inspecte ou retague lui-même (`docker buildx build`, `--push`, `docker image inspect`, `docker tag`, `UBAC_GIT_SHA`) |
| Jamais une PR | un `build` dont le `if` n'est pas exactement `github.event_name == 'push'` (§7) |
| Aucune réécriture | une construction, une vérification ou une poussée non conditionnée par l'absence constatée dans le registre ; une étape `registre` qui prendrait toute erreur pour une absence ; un `build` sans file par `github.sha` |
| Connexion | un `secrets.` ailleurs que dans l'`env` d'une étape dont le script est exactement `printf '%s' "$…" \| docker login "$REGISTRE" --username nologin --password-stdin` ; un `set -x` ou `xtrace` sur n'importe quelle ligne |
| Concurrence | un groupe sans `github.ref`, ou une annulation inconditionnelle qui interromprait `main` |

Chaque règle a au moins une **sonde** : une mutation du dépôt réel, appliquée
en mémoire, qui doit la faire rougir. Quarante-trois sondes, dont les quatre
mutations exigées par le plan — retirer `needs: test`, remplacer la couverture
par `npm test`, écrire `drizzle-kit` dans un workflow, faire diverger la version
de Node. `build` et `deploy` n'existant pas encore, les sondes de `needs`
ajoutent au workflow réel ceux des jobs du §10 qu'il n'a pas, puis cassent la
chaîne ; un test constate qu'intacte, elle passe toutes les règles. Depuis R2,
elles mordent sur le vrai `build`. Les seize sondes de R2 comprennent les trois
mutations exigées par son plan : `pull_request` ajouté aux déclencheurs de
`build`, `latest` écrit dans un tag, l'appel à `verifier-image.sh` retiré.

Le garde-fou lit **ce que les fichiers disent**, pas ce que GitHub exécute : voir
les limites.

## 4. La marge des délais, mesurée sur le runner

`test/budget-reporter.ts` fait rougir le run au-delà de 80 % du délai propre d'un
test (`docs/marge-des-delais.md`). Le plan de la phase 2 attendait le pire cas
sur le rejeu — 9 542 ms sur 30 000 au poste, 31,8 % — et demandait de **mesurer
d'abord sur le runner**. Neuf exécutions de la porte sur `ubuntu-24.04`, le
2026-09-22, tableau du reporter abaissé temporairement à 5 % pour tout voir
(commit de mesure puis revert, tous deux dans la PR). Durées en ms :

| Test (`test/`) | R1 | R2 | R3 | R4 | R5 | R6 | R7 | R8 | R9 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `jobs/purete.test.ts` > A3 | 2 419 | 3 650 | 1 971 | 2 916 | 3 852 | 4 153 | 2 826 | 3 940 | 4 636 |
| `replay/report.test.ts` > fige les six séries | 7 648 | 15 082 | 7 504 | 12 378 | 14 738 | 15 610 | 11 634 | 15 504 | 14 631 |
| `jobs/purete.test.ts` > A24 | 953 | 1 758 | 1 186 | 1 412 | 1 814 | 1 727 | 1 382 | 1 700 | 1 796 |
| `jobs/purete.test.ts` > A25 | 888 | 1 779 | 824 | 1 285 | 1 788 | 1 721 | 1 194 | 1 701 | 1 743 |
| `structure.test.ts` > C1, frontière de couche | 744 | 1 540 | 707 | 1 309 | 1 328 | 1 759 | 1 042 | 1 544 | 1 446 |
| `replay/engine.test.ts` > six séries C29 | 4 995 | 9 084 | 4 878 | 7 171 | 8 399 | 8 980 | 6 119 | 8 682 | 8 491 |
| Durée totale de vitest (s) | 30,2 | 56,1 | 29,6 | 45,3 | 55,1 | 56,5 | 41,5 | 56,0 | 55,4 |

R1 à R3 tournent avec les délais d'origine ; A3 a son délai ciblé à partir de
R4, le bloc `renderReplay` le sien à partir de R7.

Trois constats.

1. **Le pire test n'est pas celui qu'on attendait.** Le rejeu ralentit au plus
   de moitié par rapport au poste ; c'est **A3**, qui linte `src/jobs/` sept
   fois sous un délai de 5 s, qui s'effondre : 1,3 s au poste, jusqu'à 4,6 s sur
   le runner. Rapporté à 5 s, il dépasse 80 % en R6 (83 %) et en R9 (93 %) : **à
   délai inchangé, la porte aurait rougi deux fois sur neuf**, sans qu'aucune
   ligne de code ne soit en cause.
2. **Le rejeu passe la moitié de son délai sur une exécution lente.** Rapporté à
   30 s, le premier test de `renderReplay` atteint 50 %, 49 %, 52 %, 52 % et 49 %
   sur les exécutions lentes — à un facteur 1,5 de l'échec.
3. **Le runner est bruité** : de 30 à 56 s pour le même commit, et cinq
   exécutions sur neuf au-delà de 55 s.

Remède, selon la règle et sans la renégocier : des **délais ciblés, avec leur
motif écrit dans le test**. A3 reçoit 30 s, sur ce test seul, comme A22 dans le
même fichier ; A4, dans le même bloc, reste à 5 s. Le bloc `renderReplay` passe
de 30 à 60 s. Le `testTimeout` global n'est pas touché, et aucun autre test ne
change de délai.

Après correctif (R7 à R9), le pire test du runner est **A24, à 36 % de ses 5 s**
(1 796 ms), soit un facteur 2,2 avant l'échec sur l'exécution la plus lente
mesurée. A3 tient à 15 % de 30 s, le rejeu à 26 % de 60 s. A24, A25 et C1 sont
les suivants sur la liste : s'ils franchissent 50 %, le reporter l'affiche dans
le journal de la porte.

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
  dont le contenu peut changer sous la chaîne. Risque accepté, pas ignoré — et
  il pèse davantage depuis R2 : `actions/checkout` tourne dans le job qui
  détient la clé du registre.
- **Le cache npm** est restauré depuis le cache d'Actions. Il ne contient que
  `~/.npm`, dont `npm ci` vérifie chaque paquet contre l'empreinte de
  `package-lock.json`, et une PR n'écrit que dans le cache de sa propre
  référence, jamais dans celui de `main`. `actions/setup-node` recommande
  pourtant de s'en passer dans un job à privilèges : `build` (R2) ne l'utilise
  pas — il n'exécute ni `setup-node` ni `npm` hors de la construction de
  l'image, qui ne voit pas le cache. R3 devra reposer la question.
- **Une PR venue d'un fork fait tourner son code** sur le runner : le dépôt est
  public. Elle le fait avec le jeton en lecture et sans aucun secret, ce que
  `pull_request` garantit et que `pull_request_target` ne garantirait pas — d'où
  son refus par le garde-fou.
- **Node est aligné au majeur, pas au correctif.** Le runner prend le dernier
  22.x de son cache (22.23.2 le 2026-09-22), le poste celui de son image
  `node:22-bookworm` au moment où elle a été construite.
- **Une branche sans PR n'est pas testée** : voir §1, c'est voulu.
- **Le runner est partagé et bruité** (§4). Le garde-fou de marge rend un
  ralentissement visible, il ne le supprime pas : une exécution 2,2 fois plus
  lente que la plus lente mesurée ici ferait rougir A24. Et le tableau de marge
  ne s'affiche que dans le journal d'une exécution verte, qu'on ne lit pas.

## 7. L'image : le job `build`

Lot **R2**, décisions **D4 = 2** (`push` sur `main` et tags `v*`), **D5 = 1**
(deux secrets de dépôt, le reste en variables) et **D6 = 2**. Un commit de
`main`, ou un tag `v*`, produit `rg.fr-par.scw.cloud/<namespace>/ubac:<sha>`,
tagué par **son** SHA, vérifié par `scripts/verifier-image.sh` — et **rien
d'autre ne change en production** : aucun job Scaleway n'est touché.

| Étape | Ce qu'elle fait |
|---|---|
| Référence | `UBAC_REFERENCE=<image>:$(git rev-parse --verify HEAD)`, le même calcul que `build-image.sh` ; écrite dans `$GITHUB_ENV`, hors de l'arbre, qui reste propre |
| Connexion | `nologin`, et la clé secrète par l'**entrée standard** : `printf '%s' "$SCW_SECRET_KEY" \| docker login … --password-stdin`. `printf` est un intégré du shell : la clé n'est l'argument d'aucun processus |
| Registre | `docker buildx imagetools inspect` sur la référence. Présente : **rien n'est reconstruit ni réécrit**. `not found` : on construit. Toute autre erreur arrête le job |
| Construction | `./scripts/build-image.sh`, avec son `--load` |
| Vérification | `./scripts/verifier-image.sh` et ses dix contrôles, qui font **tourner** l'image locale |
| Poussée | `docker push` de la référence |
| Manifeste poussé | `imagetools inspect --format '{{json .Image}}'` sur le registre doit lire `linux/amd64` et rien d'autre |
| Déconnexion | `docker logout`, même après un échec |

**Le job ne refait ni le contrôle d'architecture ni celui du SHA embarqué** :
ils vivent dans `verifier-image.sh`, sortent en erreur, et le garde-fou refuse
qu'on les recopie dans le YAML. Le contrôle du manifeste poussé n'en est pas un
doublon : il lit ce que Scaleway ira chercher, non l'image locale.

**Pourquoi jamais une PR.** Sur `pull_request`, `actions/checkout` place HEAD sur
le **commit de fusion**. `build-image.sh` le lirait : l'image serait taguée par
un commit qui disparaît au merge, et `decisions.git_sha` désignerait
l'introuvable. Le `if: github.event_name == 'push'` ferme la porte, et le
garde-fou l'épingle mot pour mot.

**Pourquoi le registre est lu d'abord.** Un tag `v*` est posé sur un commit que
`main` a déjà construit. Le reconstruire **écraserait** sa référence par une
image qui n'est pas bit à bit la même, et détruirait sans erreur ce que
`docs/deploiement.md` §8 promet : l'image d'hier n'a jamais été écrasée. Pour la
même raison, `build` a une file par `github.sha`, sans annulation : `main` et un
tag poussés ensemble ne constatent pas l'absence en même temps.

**Les attestations de buildx.** Constaté le 2026-09-26 sur l'image déjà en
production (`2394a93`) : le registre porte un index avec `linux/amd64` **et** un
manifeste d'attestation `unknown/unknown`. Ce n'est pas une seconde plateforme ;
`.Image` l'ignore, et le contrôle lit bien `linux/amd64` seul. La construction
ne pose donc pas `--provenance=false`, et `docs/deploiement.md` §5 est précisé.

**Ce que l'opérateur a posé** (D5) : les secrets de dépôt `SCW_ACCESS_KEY` et
`SCW_SECRET_KEY`, les variables `SCW_DEFAULT_ORGANIZATION_ID`,
`SCW_DEFAULT_PROJECT_ID` et `SCW_REGISTRY_NAMESPACE` (`ubac`). Présence
constatée par `gh secret list` et `gh variable list` ; aucune valeur n'est
écrite ici. `build` n'utilise que `SCW_SECRET_KEY` et `SCW_REGISTRY_NAMESPACE` :
la clé d'accès et les identifiants d'organisation et de projet servent à R3.

**Ce que `build` ne garantit pas.**

- **Il ne tourne que sur `main` et `v*`** : une PR ne prouve pas que son image se
  construit. Le premier signal arrive après le merge, sur `main`.
- **Le secret est masqué, pas inaccessible.** Toute étape du job pourrait lire
  `~/.docker/config.json` une fois connecté ; les étapes qui suivent la
  connexion sont les deux scripts du dépôt, `docker` et `jq`.
- **Une image présente n'est pas revérifiée.** Elle l'a été au moment où elle a
  été poussée ; seul son manifeste est relu.
