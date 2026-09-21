# Plan : ubac-phase-2

Spec de référence : `docs/specs/ubac-rebalance.md` **§10, sous-section GitHub
Actions**, et elle seule. Plan établi le 2026-09-17, `main` à `5caf8a9`.
**Décisions de l'opérateur intégrées le 2026-09-17** (section « Décisions
prises »).

## Avertissement sur la référence

Comme la phase 1, la phase 2 **n'a pas de spec dédiée**. La référence est une
sous-section de dix lignes du §10, pas une liste de critères numérotés. Les
critères de validation de chaque lot tiennent donc lieu de critères
d'acceptation. C'est la même faiblesse de traçabilité qu'en phase 1, et elle se
corrigerait de la même façon : par un cadrage, si l'opérateur le décide.

Ce plan n'écrit aucun code, aucun workflow, et ne modifie aucun critère métier.

## État de départ, constaté et non supposé

`main` à `5caf8a9`. `make ci && make test` : **1 128 tests passés, 20 ignorés**
dans 2 fichiers, 12,4 s sur le poste. `make coverage` : mêmes comptes, 22,3 s,
seuil 100 % de `src/core/risk.ts` tenu.

Ce que le dépôt porte déjà, et qu'aucun lot de cette phase ne refait :

| Acquis | Fichier | Ce qu'il garantit |
|---|---|---|
| Image de production | `Dockerfile.prod` | `linux/amd64` refusé à la construction sinon ; ni devDependencies, ni `drizzle-kit`, ni `tsx` ; `GIT_SHA` scellé |
| Compilation | `tsconfig.build.json` | `dist/` seul, pas de source ni de carte |
| Construction | `scripts/build-image.sh` | tag par SHA, refus d'un arbre sale, **ne pousse pas** |
| Vérification | `scripts/verifier-image.sh` | dix contrôles sur l'image, architecture comprise, sortie en 1 par échec |
| Point d'entrée | `scripts/entrypoint-job.sh` | `run_date`, `at` et `git_sha` d'un **seul** appel à `date` |
| Procédure | `docs/deploiement.md` | les dix variables secrètes, la migration avant le déploiement, la création du job, le retour en arrière |

Ce que le dépôt **n'a pas**, vérifié le 2026-09-17 :

- aucun répertoire `.github/`, donc aucun workflow ;
- aucune protection de branche sur `main` (`404 Branch not protected`) ;
- aucun environnement GitHub (`total_count: 0`) ;
- aucun secret de dépôt (`gh secret list` vide) ;
- Actions activé, `allowed_actions: all`, `sha_pinning_required: false`.

Le dépôt est **public** (`olaurendeau/ubac`). Deux conséquences qui pèsent sur
tout ce plan : les environnements et leurs règles de protection sont gratuits,
et **les journaux d'exécution sont lisibles par n'importe qui**. Un secret qui
fuit dans une sortie ne fuit pas « chez GitHub », il fuit sur Internet.

### Travail ouvert à rattacher

**PR #45 — « Q10 : la réconciliation rafraîchit le cache »**, base `main`, 779
ajouts / 278 suppressions, `MERGEABLE`, dernier mouvement le 2026-09-16. Elle
appartient à la phase 1 et ne fait pas partie de ce plan. Depuis le report de R5
et R6 (D9), plus aucun lot de cette phase n'écrit dans `src/` : #45 ne croise
donc que **R1**, et seulement par la porte.

Recommandation : si #45 est encore en vol quand R1 est fusionné, la rebaser sur
`main` — elle devient le premier passage réel de la porte, sur du code déjà relu,
c'est-à-dire la meilleure occasion possible de découvrir que la chaîne rougit
pour une raison qui ne tient pas au code.

## Périmètre

### Ce qui est déjà en production et n'est pas replanifié

L'opérateur a levé le report de l'hébergement et de l'ordonnancement le
2026-09-15, pendant la phase 1 (lot Q9). Le projet Neon tourne, le schéma y est
appliqué, l'image de production existe, le job Serverless Scaleway tourne avec
son cron `0 7 * * *` UTC, ses dix variables secrètes et son healthcheck externe.
**Le déploiement se fait à la main**, par `docs/deploiement.md`.

Il reste donc **la seule chaîne d'intégration et de livraison**. Neon, le
registry, la définition du job, le cron, les secrets du job, updown.io et ntfy
sont des acquis : les lots s'y branchent, aucun ne les recrée.

### Ce qui reste exclu

- **Toute exécution d'ordre** : c'est la phase 3, et `docs/phase-1-frontieres.md`
  tient encore la frontière.
- **Le mode `DRY_RUN` et le `workflow_dispatch` du §10** : reportés en phase 3
  par la décision **D9**. Le motif est écrit ci-dessous, à « Ce que la phase 2 ne
  livre pas du §10 ».
- **Toute migration depuis la chaîne**, sous quelque forme que ce soit
  (`docs/base-de-donnees.md` §5).
- L'export CSV des cessions, le PRU, l'ajustement des bandes : phases
  ultérieures, inchangé.

## Ce que la phase 1 a appris, et qui gouverne ces estimations

Les estimations de la phase 1 se sont trompées d'un **facteur 2 à 3**,
systématiquement sur les lots qui touchent une frontière externe, jamais sur le
code métier (`docs/plans/ubac-phase-1.md`, « Révision des estimations »). Huit
lots sur dix ont dépassé le plafond de 1 000 lignes, de 14 à 96 %. L'écart
venait de trois postes : les tests qui figent le comportement d'un tiers, les
fixtures capturées, et la documentation de ce qui **n'est pas** garanti.

**Une chaîne CI/CD est entièrement faite de frontières externes** : GitHub
Actions, le registry Scaleway, l'API IAM, le CLI `scw`, `buildx`. Aucun lot de
ce plan n'est du code métier.

Trois conséquences, appliquées d'emblée :

1. **Les estimations ci-dessous sont déjà corrigées.** Elles disent ce que je
   m'attends à compter, pas un idéal à tenir. Un lot annoncé à 750 est un lot
   conçu pour qu'un dépassement de 30 % reste sous le plafond.
2. **Chaque lot porte son point de redécoupe écrit à l'avance.** Le coordinateur
   coupe avant le dispatch ; le worker qui dépasse coupe au point prévu sans
   nouveau cycle de planification.
3. **Le découpage est plus fin que le besoin fonctionnel ne l'exigerait.** Cinq
   lots pour trois jobs de workflow : c'est le prix de la leçon, pas un goût
   pour la fragmentation.

### Proportionner l'audit au risque

Règle arrêtée par l'opérateur le 2026-09-14 :

| | exigé |
|---|---|
| Tout lot | la **preuve par mutation** dans le rapport du constructeur |
| Lot touchant un secret, de l'argent ou un garde-fou | **plus** l'audit affirmation / variantes / sondes |

Sur cette phase, **quatre lots sur cinq tombent dans la seconde catégorie**. Un
workflow qui manipule la clé secrète Scaleway manipule un secret ; un workflow
qui repointe le job de production touche à l'argent par l'intermédiaire du run
quotidien ; une porte `test` est un garde-fou. Seul **R7**, purement
documentaire, s'en tient à la preuve par mutation.

La preuve par mutation sur un fichier YAML n'est pas évidente : c'est la raison
d'être du garde-fou `test/ci/` introduit en R1. Un workflow sans test est un
fichier dont personne ne peut montrer qu'il mord.

## Convention de livraison

Inchangée : une PR par lot, **1 000 lignes ajoutées + supprimées** au plus, code,
tests et documentation compris ; lockfiles et fichiers générés exclus du compte,
avec volume et validation documentés séparément. `make typecheck` et `make test`
sur chaque lot, `make coverage` si le risque est touché — aucun lot de cette
phase ne touche `src/core/risk.ts`, mais **R1 met la couverture dans la
chaîne**, donc le seuil devient une porte automatique et non plus une commande
que quelqu'un pense à lancer.

**Aucun secret en clair, à aucune étape.** Les lots qui touchent à des
identifiants livrent la liste des secrets attendus et la validation de leur
présence, jamais leur valeur.

## Décisions prises

Onze questions posées le 2026-09-17, onze réponses le même jour. Elles ne sont
plus des préalables : elles sont intégrées aux lots ci-dessous.

| # | Question | Réponse retenue |
|---|---|---|
| **D1** | Comment la chaîne exécute-t-elle les tests ? | **`actions/setup-node` + `npm ci`.** Rapide ; seconde définition de « comment on teste » à tenir alignée — c'est R1 qui s'en charge. |
| **D2** | Les 20 tests de base tournent-ils en CI ? | **Non.** La porte CI est la couverture sans base. `make test-db` reste une porte du poste, et le trou est **déclaré**. |
| **D3** | La porte `test` devient-elle un contrôle requis sur `main` ? | **Oui.** Protection de `main`, `test` en contrôle requis, **sans** revue requise : l'opérateur est seul. |
| **D4** | Qu'est-ce qui déclenche une construction d'image ? | **`push` sur `main` et tag `v*`.** |
| **D5** | Quels secrets GitHub, et à quelle portée ? | **Deux secrets de dépôt** : `SCW_SECRET_KEY`, `SCW_ACCESS_KEY`. Organisation, projet et namespace en **variables**, non secrètes. |
| **D6** | Les actions tierces sont-elles épinglées par SHA ? | **Non**, étiquettes majeures. Risque accepté, déclaré dans les limites. |
| **D7** | Qui approuve un déploiement ? | **Personne.** Environnement `production` **sans relecteur**, restreint à `main` : déploiement **automatique** après `build`. |
| **D8** | Que devient la procédure manuelle de `docs/deploiement.md` ? | **Supprimée** : la chaîne est le seul chemin. Portée exacte à trancher — voir **D12**. |
| **D9** | Que fait exactement `DRY_RUN` aujourd'hui ? | **Reporté en phase 3**, avec le `workflow_dispatch` du §10 qui lui est attaché. |
| **D10** | Le rapport Brevo part-il en `DRY_RUN` ? | **Non** — et sans objet en phase 2, puisque D9 reporte le mode. Conservée pour la phase 3. |
| **D11** | Où s'exécute un `DRY_RUN` ? | **Chez Scaleway**, là où les secrets vivent déjà. Sans objet en phase 2, conservée pour la phase 3. |

### Ce que ces réponses changent par rapport au plan soumis

Quatre conséquences qui ne sont pas de simples réglages :

1. **D9 retire deux lots.** R5 (le mode `DRY_RUN` dans le code) et R6 (le
   `workflow_dispatch`) partent en phase 3. La phase 2 passe de sept lots à
   cinq, et perd le seul lot qui écrivait dans `src/`.
2. **D7 retire l'humain de la boucle.** Le plan soumis supposait une approbation
   à chaque déploiement. Avec le déploiement automatique, **la relecture de la
   définition (R3) et la barrière de migration (R4) ne sont plus des filets :
   ce sont les seuls contrôles qui existent** entre un merge et 7 h du matin.
3. **D7 impose donc une séquence, qui n'était pas dans le plan soumis.** R3 ne
   doit pas ouvrir le déploiement automatique avant que R4 existe : voir « La
   rampe de R3 à R4 ».
4. **D8 + D9 laissent le retour en arrière sans procédure écrite.** La procédure
   manuelle disparaît, et le bouton qui l'aurait remplacée est reporté. D'où
   **D12**, attachée à R7.

### D12 — la seule question qui reste ouverte

Attachée à **R7**, à trancher avant son dispatch, pas maintenant.

**D8 supprime la procédure manuelle. Deux sections de `docs/deploiement.md` ne
sont couvertes par rien dans la chaîne :**

- **§2, les migrations.** La chaîne ne migre **jamais** (R4 la fait refuser). Si
  §2 disparaît, la commande que R4 affiche dans son message de refus ne pointe
  plus vers rien.
- **§8, le retour en arrière.** Le `workflow_dispatch` qui l'aurait automatisé
  est reporté en phase 3 (D9). Si §8 disparaît, revenir à l'image d'hier n'est
  écrit nulle part.

Options :

1. Supprimer **le chemin manuel de construction et de déploiement** (§3 à §7),
   **garder** §1 (les dix variables), §2 (migrations) et §8 (retour en arrière).
2. Tout supprimer : la console Scaleway est le recours, non documenté.

## Lots

> **R5 et R6 n'apparaissent pas**, et ce n'est pas une erreur de numérotation :
> ils sont reportés en phase 3 par D9. Les numéros restants ne sont pas
> recompactés, pour que « R3 » désigne le même lot dans ce plan, dans la PR #46
> et dans les tâches Orca.

### R1 — La porte `test`

- Dépend de : rien. Premier lot de la phase.
- Décisions intégrées : **D1 = 2**, **D2 = 1**, **D3 = 1**.
- Catégorie d'audit : **garde-fou** → mutation **+** affirmation / variantes / sondes.
- Diff estimé compté : **~750 lignes**.
- Fichiers prévus : `.github/workflows/ci.yml`, `test/ci/workflow.test.ts`,
  `docs/integration-continue.md`.

**Résultat** : chaque poussée et chaque PR exécutent la porte du dépôt, seuil de
couverture de `risk.ts` compris, et **aucune PR ne peut être fusionnée sans
elle**.

Le job `test` tourne sur `actions/setup-node` (D1), avec le cache `npm` :
`npm ci`, `npm run typecheck`, `npm run test:coverage`. Il exécute **la
couverture et non `npm test`** : la couverture rejoue toute la suite *et* fait
respecter les 100 % de `src/core/risk.ts`, que le §10 nomme explicitement.
Exécuter les deux paierait la suite deux fois ; n'exécuter que `npm test`
donnerait une garantie strictement plus faible que celle que le §10 demande.

**D1 = 2 crée une seconde définition de « comment on teste »**, à côté du
`Makefile` et de Compose. C'est le coût assumé de la rapidité, et c'est au
garde-fou de le rendre visible : `test/ci/workflow.test.ts` asserte que la
version de Node du workflow satisfait le `engines` de `package.json`, et que les
commandes du workflow sont bien des scripts déclarés dans `package.json`. Une
divergence doit rougir sur le poste, pas se découvrir six mois plus tard.

Le garde-fou asserte aussi ce que les workflows affirment : que `build` dépend
de `test`, que `deploy` dépend de `build`, qu'aucun `latest` n'apparaît, et
qu'aucune ligne ne prononce `drizzle-kit`, `db-push` ni `db:push`. C'est ce qui
rend la preuve par mutation possible sur du YAML : retirer `needs: test` doit
faire rougir la suite du poste, pas seulement la chaîne.

Enfin, **D3 est un geste de console, pas une ligne de code** : protéger `main`,
`test` en contrôle requis, sans revue requise. Il est posé par l'opérateur au
moment du merge de R1, et `docs/integration-continue.md` écrit ce qui a été
coché — car aucun test ne peut le vérifier (voir les limites déclarées).

**Critères de validation** : la chaîne passe au vert sur sa propre PR ;
`make check` passe sur le poste ; **une PR dont un test échoue ne peut pas être
fusionnée** une fois D3 posé ; le garde-fou échoue si l'on retire `needs: test`,
si l'on remplace la couverture par `npm test`, si l'on écrit `drizzle-kit` dans
un workflow, ou si la version de Node du workflow cesse de satisfaire
`package.json` — les quatre mutations sont appliquées, constatées et restaurées
dans le rapport.

**Pièges connus.**

1. **La marge des délais, mesurée.** `test/budget-reporter.ts` fait rougir le run
   au-delà de 80 % du délai propre d'un test. Sous couverture, sur le poste, le
   pire test consomme **9 542 ms sur 30 000, soit 31,8 %**. Le seuil d'échec est
   donc atteint par un runner **2,5 fois plus lent que ce Mac** — ce qui n'est
   pas hors d'atteinte pour un `ubuntu-latest` partagé sur du v8 instrumenté. Le
   lot **mesure d'abord** sur le runner et rapporte le ratio réel. Si la marge
   manque, le remède est un délai **ciblé** sur le bloc concerné avec son motif
   écrit, **jamais** un `testTimeout` global relevé : `docs/marge-des-delais.md`
   dit pourquoi, et la règle ne se renégocie pas parce que la machine a changé.
2. **Les vingt tests ignorés en silence** — 16 dans `test/adapters/db.test.ts`,
   4 dans `test/adapters/schema-contraintes.test.ts`. D2 les laisse dehors :
   `docs/integration-continue.md` écrit noir sur blanc que **l'index unique,
   c'est-à-dire la garantie d'idempotence du run, n'est pas couvert par la
   porte**. Une pastille verte ne doit pas laisser croire le contraire.
3. **Le jeton du workflow.** Dépôt public : `permissions: contents: read` et rien
   d'autre sur ce job. Le défaut du dépôt est plus large.
4. **Les exécutions superposées.** Un `concurrency` par référence, qui annule la
   précédente, évite qu'une rafale de poussées ne fasse tourner cinq suites.
5. **Le contrôle requis et son nom.** D3 épingle un contrôle **par son nom de
   job**. Renommer le job dans le YAML désarme la protection sans qu'aucune ligne
   ne rougisse : le nom est donc un contrat, et le garde-fou l'épingle.

**Point de redécoupe prévu** : si le lot dépasse, le garde-fou
`test/ci/workflow.test.ts` part en **R1b** et R1a livre le workflow seul. C'est
la coupure la plus propre : elle laisse une PR entièrement YAML et une PR
entièrement TypeScript.

---

### R2 — L'image construite, vérifiée et poussée par la chaîne

- Dépend de : **R1** fusionné.
- Décisions intégrées : **D4 = 2**, **D5 = 1**, **D6 = 2**.
- Catégorie d'audit : **secret** → mutation **+** affirmation / variantes / sondes.
- Diff estimé compté : **~800 lignes**.
- Fichiers prévus : `.github/workflows/ci.yml` (job `build`),
  `docs/integration-continue.md`, `test/ci/workflow.test.ts`,
  `docs/deploiement.md` §9.

**Résultat** : un commit de `main`, ou un tag `v*`, produit dans le registry
privé une image taguée par **son** SHA, vérifiée par
`scripts/verifier-image.sh`, et **rien d'autre ne change en production**.

Le job réutilise les deux scripts du dépôt : il construit avec
`scripts/build-image.sh`, vérifie avec `scripts/verifier-image.sh`, puis se
connecte et pousse. Il **ne refait ni la vérification d'architecture ni le
contrôle du SHA embarqué** : ils existent, ils sortent en 1, et les recopier
dans du YAML créerait une seconde définition libre de diverger.

Prérequis opérateur, à poser avant le dispatch : l'application IAM dédiée, sa
policy **limitée à `ContainerRegistryFullAccess` et `ServerlessJobsFullAccess`**,
et les deux secrets de D5. La documentation les nomme ; elle ne porte aucune
valeur.

**Critères de validation** : une poussée sur `main` produit
`rg.fr-par.scw.cloud/<namespace>/ubac:<sha>` ; `docker buildx imagetools inspect`
sur l'image **poussée** montre `linux/amd64` **et aucune autre plateforme** ; le
journal public ne contient la clé secrète sous aucune forme ; **un tag `v*` posé
sur un commit déjà construit ne réécrit pas son image** ; le garde-fou échoue si
un `latest` apparaît dans un workflow.

**Pièges connus.**

1. **Le SHA du commit de fusion.** Sur un événement `pull_request`,
   `actions/checkout` place HEAD sur le commit de fusion. `build-image.sh` lit
   `git rev-parse HEAD` : l'image serait taguée par un commit qui disparaît après
   le merge, et `decisions.git_sha` désignerait l'introuvable. D4 = 2 ferme la
   porte en ne construisant que sur `main` et sur `v*` — mais le garde-fou
   l'épingle, parce que rien n'empêche un lot ultérieur d'ajouter l'événement.
2. **D4 = 2 ouvre deux chemins vers le même SHA.** Un tag `v*` est posé sur un
   commit **déjà** présent sur `main`, donc déjà construit : le second passage
   reconstruirait la même référence `…:<sha>` et **l'écraserait**. Or c'est
   exactement la propriété que `docs/deploiement.md` §8 vend : « le retour en
   arrière est gratuit, l'image n'ayant jamais été écrasée ». Une image
   reconstruite n'est pas bit à bit la précédente. **Le job doit donc vérifier
   l'existence de la référence dans le registry et sauter la construction si elle
   existe**, plutôt que de la remplacer. C'est le piège le plus coûteux de ce lot,
   parce qu'il détruit une garantie sans qu'aucune étape n'échoue.
3. **Les manifestes d'attestation de buildx.** Constaté sur ce poste : une
   construction buildx ordinaire émet un `exporting attestation manifest` et une
   `manifest list` là où on n'attend qu'une image. Si ces attestations
   accompagnent la poussée — **à vérifier sur le registry, pas à supposer** —
   `docker buildx imagetools inspect` montrera une entrée supplémentaire, et
   `docs/deploiement.md` §5 demande de voir « une ligne `Platform: linux/amd64`,
   et aucune autre plateforme ». Le lot constate ce que le registry répond, puis
   tranche : soit la construction pose `--provenance=false`, soit la
   documentation est corrigée. L'un ou l'autre, jamais ni l'un ni l'autre.
4. **`--load` puis `push`.** `verifier-image.sh` fait *tourner* l'image : elle
   doit donc être dans le démon local, pas seulement dans le registry. Un
   `--push` direct sauterait les dix contrôles, y compris ceux qui prouvent que
   le graphe ESM se résout.
5. **Le mot de passe dans la ligne de commande.** `--password-stdin`, comme le
   fait déjà `docs/deploiement.md` §5. Actions masque les secrets dans ses
   journaux, mais un `set -x` ou une trace de `docker` recopient la valeur, et le
   journal est public.
6. **L'arbre sale.** `build-image.sh` refuse un arbre sale et n'a pas de drapeau
   pour passer outre. Une étape qui écrirait un fichier avant la construction —
   un cache, un rapport, un fichier de version — ferait échouer le lot pour une
   raison qui n'a rien à voir avec l'image.

**Point de redécoupe prévu** : **R2a** construction + vérification, sans
connexion ni poussée (l'artefact reste dans le runner) ; **R2b** connexion,
poussée, contrôle du manifeste poussé et refus de réécriture. La coupure isole
exactement la partie qui manipule le secret.

---

### R3 — Le déploiement, sous environnement protégé

- Dépend de : **R2** fusionné.
- Décision intégrée : **D7 = 2**.
- Catégorie d'audit : **secret + argent + garde-fou** → mutation **+** audit complet.
- Diff estimé compté : **~800 lignes**.
- Fichiers prévus : `.github/workflows/ci.yml` (job `deploy`),
  `docs/integration-continue.md`, `docs/deploiement.md`,
  `test/ci/workflow.test.ts`.

**Résultat** : un tag `v*` repointe la définition du job Scaleway sur l'image de
ce commit, **relit la définition** pour le prouver, et laisse le cron, le
timeout, les tentatives et les dix variables secrètes exactement où ils étaient.

#### La rampe de R3 à R4

**D7 = 2 supprime l'humain de la boucle.** Le plan soumis supposait une
approbation à chaque déploiement ; ce n'est plus le cas. Livrer R3 tel quel
ouvrirait immédiatement le déploiement automatique de **tout** merge sur `main`,
y compris d'un merge qui change `src/adapters/schema.ts` — et la barrière qui
l'attrape, R4, n'existerait pas encore. Le plan soumis plaçait R4 après R3 sans
en tirer la conséquence : avec une approbation humaine, la fenêtre était
tolérable ; sans, elle ne l'est pas.

D4 = 2 donne la rampe gratuitement, puisqu'il existe **deux** déclencheurs :

| Lot | `deploy` se déclenche sur | Pourquoi |
|---|---|---|
| **R3** | **tag `v*` uniquement** | poser un tag est un geste délibéré et rare : c'est l'humain, replacé dans la boucle le temps que la barrière existe |
| **R4** | **+ `push` sur `main`** | la barrière de migration est livrée, le déploiement automatique s'ouvre |

C'est R4 qui ouvre le chemin automatique, et c'est la raison pour laquelle R4
n'est pas un lot de confort qu'on pourrait repousser.

#### La relecture

La relecture n'est pas une précaution de confort : **c'est le seul contrôle qui
existe entre le déploiement et 7 h du matin**, et depuis D7 = 2 il n'y a plus
d'humain derrière. Elle asserte, après la mise à jour, que `image-uri` vaut le
tag attendu **et** que `cron.schedule`, `cron.timezone`, `job-timeout`,
`max-retries`, `memory-limit` et `cpu-limit` valent encore ce que
`docs/deploiement.md` §6 fige. Un déploiement qui réussit et qui a effacé le cron
est indistinguable d'un déploiement réussi, jusqu'au lendemain matin.

Le job écrit dans son journal **le tag précédent** avant de le remplacer. Depuis
D8 = 2 et le report de R6, cette ligne de journal **est** la procédure de retour
en arrière : c'est le seul endroit où le tag précédent reste écrit.

**Critères de validation** : un tag `v*` déploie, un `push` sur `main` **ne
déploie pas** ; après un déploiement, la définition lue chez Scaleway porte le
nouveau tag et les six réglages inchangés ; le journal porte le tag précédent ;
**le run du lendemain matin conclut** — updown en `UP` avec `RUN_CONCLU`, quatre
lignes de `decisions` dont le `git_sha` égale le nouveau tag.

**Pièges connus.**

1. **Les noms d'arguments du CLI `scw` ne sont pas vérifiés.**
   `docs/deploiement.md` §6 le dit déjà pour la création ; c'est vrai aussi pour
   la mise à jour et la lecture. Le lot les confirme avec
   `scw jobs definition update -h` **avant** de les écrire, et le rapporte.
2. **Mise à jour partielle contre remplacement.** Il n'est pas acquis qu'une mise
   à jour ne modifiant que `image-uri` laisse les autres champs intacts. C'est
   exactement ce que la relecture existe pour constater — et la raison pour
   laquelle elle asserte six réglages et pas seulement le tag.
3. **La fenêtre de 7 h UTC, qui n'est plus théorique.** Sans approbation
   humaine, un déploiement part quand un tag est posé — y compris à 6 h 58. Un
   déploiement *cassé* juste avant le cron coûte une journée d'observation. Le
   lot **refuse de déployer entre 06 h 45 et 07 h 15 UTC** et le dit dans son
   journal, plutôt que de tenter sa chance. Quinze minutes d'attente ne coûtent
   rien ; une journée d'observation, si.
4. **« Environnement protégé » sans relecteur.** D7 = 2 satisfait le §10 par la
   **restriction de branche** seule. C'est une règle de protection, donc
   l'exigence est tenue à la lettre — mais elle est faible, et les limites
   déclarées doivent le dire au lieu de laisser le mot « protégé » faire croire
   qu'un humain regarde.
5. **L'environnement protégé dépend de la visibilité du dépôt.** Les règles de
   protection d'environnement sont gratuites sur un dépôt **public**. Si le dépôt
   passait un jour en privé sans forfait payant, elles cesseraient d'être
   appliquées — sans que le workflow change d'une ligne.
6. **Aucune migration ici.** Le job `deploy` ne touche pas à la base. C'est R4
   qui rend ce silence vérifiable.

**Point de redécoupe prévu** : **R3a** le job `deploy`, l'environnement et le
déclencheur `v*` ; **R3b** la relecture des six réglages, la fenêtre de 7 h et le
tag précédent journalisé.

---

### R4 — La barrière de migration, et l'ouverture du déploiement automatique

- Dépend de : **R3** fusionné.
- Décision intégrée : **D7 = 2** (c'est ce lot qui ouvre le chemin automatique).
- Catégorie d'audit : **garde-fou** → mutation **+** audit complet.
- Diff estimé compté : **~600 lignes**.
- Fichiers prévus : `.github/workflows/ci.yml` (étape de `deploy`),
  `docs/integration-continue.md`, `docs/base-de-donnees.md`,
  `test/ci/workflow.test.ts`.

**Résultat** : **la chaîne ne migre jamais, et refuse de déployer une migration
qu'elle ne peut pas prouver appliquée.** Une fois la barrière en place, le
déploiement s'ouvre au `push` sur `main`.

C'est la réponse à la question « comment une migration s'articule avec un
déploiement automatisé sans jamais entrer dans la chaîne ». Le mécanisme :

1. la chaîne lit le tag actuellement déployé dans la définition du job — c'est le
   SHA du code qui tourne en production ;
2. elle compare `src/adapters/schema.ts` entre ce SHA et le candidat ;
3. **identique** : rien à faire, le déploiement suit son cours ;
4. **différent** : le déploiement est **refusé**, avec le message qui nomme la
   commande de `docs/deploiement.md` §2 et rappelle que `push` s'exécute depuis un
   terminal, sur la base réelle, avec le SQL sous les yeux ;
5. l'opérateur applique la migration depuis le poste, puis relance le
   déploiement en déclarant le SHA migré. La déclaration porte sur **un SHA
   précis** : elle ne peut pas être réutilisée pour le suivant.

La chaîne n'ouvre donc jamais de connexion à Neon, n'embarque jamais
`drizzle-kit` — l'image ne le contient pas et `verifier-image.sh` le vérifie — et
ne connaît pas `DATABASE_URL`. Elle sait seulement **dire non**.

**Critères de validation** : un commit qui modifie `schema.ts` fait refuser le
déploiement ; le même commit passe après déclaration du SHA ; une déclaration
portant un autre SHA ne débloque rien ; un commit qui ne touche pas `schema.ts`
passe sans rien demander ; **un `push` sur `main` déploie désormais**, ce que R3
interdisait. Les cinq cas sont des sondes distinctes, et la mutation à appliquer
est le retrait de la comparaison.

**Pièges connus.**

1. **La profondeur de l'historique.** `actions/checkout` clone en profondeur 1 :
   le SHA déployé n'est pas dans le dépôt local, et la comparaison échoue sans
   rien dire d'utile. `fetch-depth: 0`, ou une récupération explicite du SHA
   déployé.
2. **Le premier déploiement.** Aucun tag précédent lisible — au premier passage,
   ou si la définition a été créée à la main. Le cas doit se comporter comme
   « différent » : refuser et demander confirmation, jamais laisser passer.
3. **Ce que le contrôle ne voit pas.** Il compare **un fichier**. Un changement
   de schéma introduit ailleurs — une contrainte posée à la main, un index créé
   dans la console — lui échappe. À écrire dans les limites déclarées plutôt
   qu'à laisser croire.
4. **La tentation inverse.** La solution « évidente » est de faire migrer la
   chaîne avec un drapeau de sûreté. C'est précisément ce que §5 interdit, et le
   motif n'est pas l'organisation : `push` exécute ses `DROP` sans question hors
   terminal, sur le journal immuable des décisions.
5. **La déclaration de SHA est une porte ouverte par construction.** Elle existe
   pour être utilisée, donc elle peut être utilisée à tort — on déclare avoir
   migré sans l'avoir fait. Le garde-fou réduit la surface d'erreur, il ne
   démontre rien : à verser aux limites déclarées, comme la phase 1 l'a fait pour
   la règle ESLint.

**Point de redécoupe prévu** : **R4a** la barrière, déclencheur `v*` inchangé ;
**R4b** l'ouverture au `push` sur `main`. La coupure sépare le contrôle de son
effet, ce qui permet de constater le premier sans subir le second.

---

### R7 — La clôture : ce que la chaîne fait, ce que le poste garde

- Dépend de : **R4** fusionné.
- Décisions intégrées : **D8 = 2**, et **D12** à trancher avant dispatch.
- Catégorie d'audit : **mutation seule**. Aucun secret, aucune écriture, aucun
  garde-fou : c'est le seul lot de la phase dans ce cas.
- Diff estimé compté : **~400 lignes**, dont une majorité de **suppressions**.
- Fichiers prévus : `docs/deploiement.md`, `docs/integration-continue.md`,
  `docs/plans/ubac-phase-2.md`.

**Résultat** : la procédure manuelle disparaît (D8), et le partage du travail
entre la chaîne et le poste est écrit une fois pour toutes :

| Geste | Qui |
|---|---|
| Tester, construire, vérifier, pousser | la chaîne |
| Déployer | la chaîne, **sans approbation** (D7) |
| **Migrer** | **le poste, toujours** |
| Rejouer en `DRY_RUN` | **personne — reporté en phase 3** (D9) |
| Retour en arrière | selon **D12** |

**Critères de validation** : aucune affirmation de `docs/deploiement.md` ne
contredit la chaîne livrée ; les commandes citées sont celles qui existent ;
**le message de refus de R4 pointe vers une section qui existe encore** ;
`make check` passe.

**Piège connu** : c'est un lot de suppression, et une suppression ne rougit
nulle part. Le seul contrôle est la relecture croisée des renvois — R4 renvoie à
§2, la relecture de R3 renvoie à §6. Supprimer une section encore citée casse un
message d'erreur que personne ne lira avant d'en avoir besoin.

---

## Ce que la phase 2 ne livre pas du §10

**Le `workflow_dispatch` et son drapeau `DRY_RUN` sont reportés en phase 3**
(D9). Le motif n'est pas l'arbitrage de coût, il est structurel :

- en phase 2, l'adapter Coinbase est **en lecture seule** : il n'expose aucune
  méthode de placement, d'annulation ou de retrait. Un « mock qui journalise ce
  qu'il aurait fait » n'a **rien à journaliser** ;
- la règle ESLint de `docs/phase-1-frontieres.md` interdit de **nommer** un
  placement d'ordre dans `src/adapters/**`, chaîne de caractères comprise. Un
  mock qui écrirait `j'aurais appelé createOrder` **ne passe pas le lint** ;
- ce qu'un `DRY_RUN` protégerait aujourd'hui n'est donc pas l'exécution mais
  **l'écriture** : les quatre lignes de `decisions`, la photo du jour, le rapport
  et le ping. C'est un autre objet que celui du §10, et il a sa propre valeur —
  mais il ne se confond pas avec lui.

Le §10 reste donc **partiellement couvert**, volontairement, et la phase 3 le
reprendra avec le déplacement du garde-fou de phase. D10 et D11 sont conservées
telles quelles pour ce moment-là.

## Couverture des exigences de la spec

| Exigence du §10 | Lot |
|---|---|
| `test` bloquant, **couche risque incluse** | R1 (via la couverture) |
| `test` réellement **bloquant** sur `main` | R1 (D3, geste de console) |
| `build` dépend de `test` (`needs:`) | R2 |
| `deploy` dépend de `build` | R3 |
| `deploy` sur **environnement protégé** | R3 (D7 = 2 : restriction de branche, **sans relecteur**) |
| Login registry : `nologin` + clé secrète Scaleway | R2 (D5) |
| **Tag par SHA de commit, jamais `latest`** | R2 (D4), asserté par le garde-fou de R1 |
| Application IAM dédiée, policy limitée aux deux droits | R2 (D5), prérequis opérateur |
| `workflow_dispatch` avec drapeau `DRY_RUN` | **reporté en phase 3** (D9) — motif ci-dessus |
| `DRY_RUN` : même image, adapter remplacé par un mock qui journalise | **reporté en phase 3** (D9) |
| Build explicitement `linux/amd64` | **acquis** (`Dockerfile.prod`, `build-image.sh`), vérifié par R2 |
| Architecture prouvée après coup | **acquis** (`verifier-image.sh`), appelé par R2 |
| Registry privé, namespace `fr-par` | **acquis** (phase 1, Q9) |
| Neon eu-central-1, chaîne pooled | **acquis** (phase 1, Q2) |
| Job 256 Mo / 0,1 vCPU / timeout 5 min / retries 0 / cron | **acquis** (Q9), **protégé** par la relecture de R3 |
| Dix variables secrètes chez Scaleway | **acquis** (Q9), **non recopiées** dans GitHub (D5) |
| Migrations : depuis le poste, jamais depuis une CI | R4 |
| SHA persisté dans `decisions`, traçabilité d'une décision douteuse | **acquis** (Q9) ; R2 en préserve la condition (piège 2), R3 en journalise le tag précédent |
| Retour en arrière par repointage du tag | **acquis** (`docs/deploiement.md` §8) ; R3 en journalise le tag ; son sort écrit dépend de **D12** |

Deux exigences du §10 sont **explicitement reportées**, les autres sont couvertes
par un lot ou par un acquis.

## Ordre, concurrence et sérialisation

**Cette phase ne se parallélise pas du tout, et il faut le dire.** Le plan
soumis annonçait un seul lot réellement parallèle, R5 ; D9 l'a reporté en
phase 3. Il ne reste que la chaîne, et les cinq lots écrivent tous dans
`.github/workflows/ci.yml` et dans `test/ci/workflow.test.ts`.

Le `needs:` que le §10 exige impose un **workflow unique** pour `test` →
`build` → `deploy` ; le contourner par un `workflow_run` coûterait plus cher que
le parallélisme gagné — il ne s'affiche pas sur les PR, ne bloque pas un merge, et
s'exécute dans la version de la branche par défaut.

| Vague | Lot | Workers |
|---|---|---|
| 1 | **R1** | 1 |
| 2 | **R2** | 1 |
| 3 | **R3** | 1 |
| 4 | **R4** | 1 |
| 5 | **R7** | 1 |

- **Un seul worker, cinq fois de suite.** Le plafond de trois n'est pas seulement
  inatteignable : il n'y a rien à lui donner. Ce n'est pas un défaut de
  découpage, c'est la forme de l'objet — une chaîne est un artefact unique.
- Le coordinateur peut, en revanche, **dispatcher la phase 3 ou un lot hors
  périmètre en parallèle** : cette phase laisse deux workers libres en permanence.
- **Fichiers à sérialiser** : `.github/workflows/ci.yml`,
  `test/ci/workflow.test.ts`, `docs/integration-continue.md`,
  `docs/deploiement.md`. Les cinq lots les touchent.
- **PR #45** est indépendante de tout cela depuis le report de R5.

## La continuité du mois d'observation

Le mois d'observation de la phase 1 court pendant toute cette phase, et
**D7 = 2 en fait le sujet principal** : le déploiement n'a plus d'humain devant
lui.

1. **R1 et R2 ne modifient pas la définition du job.** Tant qu'ils sont en vol,
   la production tourne sur l'image déployée à la main au commit `5caf8a9`,
   inchangée.
2. **R3 est le premier lot qui peut casser un matin** — d'où son déclencheur
   limité au tag `v*`, sa relecture des six réglages, et son refus de déployer
   dans la fenêtre de 7 h.
3. **R4 est le lot qui ouvre la porte.** Après lui, tout merge sur `main` part en
   production sans que personne ne clique. C'est pour cela qu'il livre la
   barrière **avant** d'ouvrir, et non l'inverse.
4. **Après chaque déploiement, le run du lendemain est un critère**, pas une
   observation optionnelle : updown en `UP` avec `RUN_CONCLU`, quatre lignes de
   `decisions` portant le nouveau `git_sha`.
5. **Le retour en arrière reste techniquement gratuit** — repointer la définition
   sur le tag précédent — à deux conditions que ce plan porte : que R2 n'ait
   jamais réécrit une image existante (piège 2), et que le tag précédent reste
   écrit quelque part (journal de R3, puis D12).

## Ce que cette phase ne garantira pas

À écrire dans `docs/integration-continue.md` plutôt qu'à laisser croire :

- **La porte `test` ne couvre pas la base** (D2) : vingt tests, dont ceux qui
  prouvent que l'index unique refuse un doublon, restent une porte du poste.
- **Personne n'approuve un déploiement** (D7). « Environnement protégé » désigne
  ici une restriction de branche, pas un regard humain.
- **Les actions tierces ne sont pas épinglées** (D6) : une étiquette majeure peut
  changer de contenu sous une chaîne qui détient la clé de déploiement. Risque
  accepté, pas ignoré.
- **Aucun mode `DRY_RUN`** (D9) : il n'existe aucun moyen d'essayer un changement
  de bandes sans écrire la journée. Le run quotidien reste le seul run.
- Le garde-fou de workflow lit **ce que les fichiers disent**, pas ce que GitHub
  exécute. Il ne voit ni un contrôle requis retiré dans les réglages du dépôt, ni
  une règle d'environnement modifiée à la console. **D3 et D7 sont des gestes de
  console, invérifiables par un test.**
- **La barrière de migration compare un fichier**, et sa déclaration de SHA est
  une porte ouverte par construction.
- Aucun de ces contrôles ne remplace la garantie structurelle de la phase 1 : une
  clé d'API sans permission de trade.

## Sur la durée annoncée

Le §13 annonce « une soirée » pour la phase 2. La phase 0 l'a démenti pour son
propre périmètre, la phase 1 aussi, et la phase 2 est faite **entièrement** de
frontières externes — celles-là mêmes sur lesquelles les estimations de la
phase 1 se sont trompées d'un facteur 2 à 3. Cinq lots, quatre en audit complet,
strictement sériels, plus deux lots reportés en phase 3 : aucune estimation en
soirées n'est donnée ici. Les temps réels se mesurent pendant les cycles Orca,
comme en phase 1.
