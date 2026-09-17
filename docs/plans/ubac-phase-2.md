# Plan : ubac-phase-2

Spec de référence : `docs/specs/ubac-rebalance.md` **§10, sous-section GitHub
Actions**, et elle seule. Plan établi le 2026-09-17, `main` à `5caf8a9`.

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
appartient à la phase 1 et ne fait pas partie de ce plan, mais elle en croise
deux lots :

1. dès que **R1** est fusionné, la PR #45 devient la première à recevoir la
   porte `test` — son merge dépendra du résultat de la chaîne, et non plus du
   seul retour du relecteur ;
2. elle touche `src/jobs/` et `src/adapters/`, comme **R5**. Les deux ne doivent
   pas être en vol en même temps.

Recommandation : **fusionner #45 avant d'ouvrir R5**. Si elle est encore en vol
quand R1 est fusionné, la rebaser sur `main` : elle devient alors le premier
passage réel de la porte, sur du code déjà relu — la meilleure occasion possible
de découvrir que la chaîne rougit pour une raison qui ne tient pas au code.

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
  tient encore la frontière. Un mock qui journalise un placement d'ordre ne peut
  pas être écrit aujourd'hui — voir le piège de **R5**.
- **Toute migration depuis la chaîne**, sous quelque forme que ce soit
  (`docs/base-de-donnees.md` §5).
- L'export CSV des cessions, le PRU, l'ajustement des bandes : phases
  ultérieures, inchangé.
- La procédure manuelle de `docs/deploiement.md` n'est **pas** supprimée par ce
  plan : son sort est la décision **D8**.

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
3. **Le découpage est plus fin que le besoin fonctionnel ne l'exigerait.** Sept
   lots pour trois jobs de workflow : c'est le prix de la leçon, pas un goût
   pour la fragmentation.

### Proportionner l'audit au risque

Règle arrêtée par l'opérateur le 2026-09-14 :

| | exigé |
|---|---|
| Tout lot | la **preuve par mutation** dans le rapport du constructeur |
| Lot touchant un secret, de l'argent ou un garde-fou | **plus** l'audit affirmation / variantes / sondes |

Sur cette phase, **six lots sur sept tombent dans la seconde catégorie**. Un
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
phase ne touche `src/core/risk.ts`, mais **R1 met `make coverage` dans la
chaîne**, donc le seuil devient une porte automatique et non plus une commande
que quelqu'un pense à lancer.

**Aucun secret en clair, à aucune étape.** Les lots qui touchent à des
identifiants livrent la liste des secrets attendus et la validation de leur
présence, jamais leur valeur.

## Décisions préalables

Onze ambiguïtés. Chacune bloque son lot et demande une réponse avant dispatch.
Les options sont numérotées : une réponse est un chiffre par décision.

| # | Question | Options | Lot bloqué |
|---|---|---|---|
| **D1** | **Comment la chaîne exécute-t-elle les tests ?** `AGENTS.md` interdit Node sur le poste et impose Docker Compose ; un runner n'est pas le poste, mais deux définitions de « comment on teste » peuvent diverger en silence. | 1) `make ci && make typecheck && make coverage` via Compose : une seule définition, plus lent. 2) `actions/setup-node` + `npm ci` : rapide, seconde définition à tenir. | R1 |
| **D2** | **Les 20 tests de base tournent-ils en CI ?** `make test` les ignore quand `UBAC_TEST_DATABASE_URL` est absente — sans bruit. Ils couvrent l'adapter et **l'index unique, qui est la garantie d'idempotence du run**. Les appliquer en CI demanderait un schéma, or `drizzle-kit push` ne doit jamais y tourner. | 1) Non : la porte CI est `make coverage` sans base, le trou est déclaré, `make test-db` reste une porte du poste. 2) Oui, par du SQL versionné produit par `drizzle-kit generate` et appliqué avec `psql` — nouveau lot, change la stratégie de `docs/base-de-donnees.md`. 3) Oui, par `drizzle-kit push` sur un Postgres éphémère — demande de lever la règle §5. | R1 |
| **D3** | **La porte `test` devient-elle un contrôle requis sur `main` ?** Sans protection de branche, « bloquant » ne bloque rien : le job rapporte, le coordinateur fusionne quand même. | 1) Oui : protection de `main`, `test` en contrôle requis, sans revue requise (l'opérateur est seul). 2) Non : la discipline du coordinateur suffit. | R1 |
| **D4** | **Qu'est-ce qui déclenche une construction d'image ?** Une construction sur `pull_request` tague l'image par le **SHA du commit de fusion**, qui n'existe dans aucune branche après le merge : `decisions.git_sha` désignerait un commit introuvable. | 1) `push` sur `main` uniquement. 2) `push` sur `main` **et** tag `v*`. 3) `workflow_dispatch` manuel seulement. | R2 |
| **D5** | **Quels secrets GitHub, et à quelle portée ?** La chaîne n'a besoin que de l'application IAM du §10. Les dix variables du job **restent chez Scaleway**. | 1) Deux secrets de dépôt : `SCW_SECRET_KEY`, `SCW_ACCESS_KEY`, plus les identifiants non secrets (organisation, projet, namespace) en variables. 2) Les mêmes, portés par l'environnement protégé plutôt que par le dépôt : le job `build` n'y accède alors pas. | R2 |
| **D6** | **Les actions tierces sont-elles épinglées par SHA ?** `sha_pinning_required` est à `false`, et `actions/checkout@v5` suit une étiquette mobile. Le dépôt est public et la chaîne détient la clé de déploiement. | 1) Oui, épinglage par SHA commenté avec la version. 2) Non, étiquettes majeures. | R2 |
| **D7** | **Qui approuve un déploiement, et sur quel environnement ?** GitHub autorise un approbateur à valider son propre déploiement — l'opérateur seul suffit donc techniquement. | 1) Environnement `production` avec l'opérateur en relecteur requis : chaque déploiement demande un clic. 2) Environnement `production` sans relecteur, mais restreint à `main` : déploiement automatique après `build`. 3) Environnement + relecteur + délai d'attente. | R3 |
| **D8** | **Que devient la procédure manuelle de `docs/deploiement.md` une fois la chaîne en place ?** | 1) Gardée comme secours, explicitement, avec les cas où elle reprend la main (GitHub indisponible, retour en arrière urgent). 2) Supprimée : la chaîne est le seul chemin. | R3, R7 |
| **D9** | **Que fait exactement `DRY_RUN` aujourd'hui ?** Le §10 dit « adapter Coinbase remplacé par un mock qui journalise ». En phase 2 l'adapter Coinbase est **en lecture seule** : il n'y a rien à mocker, et la règle ESLint du §7 interdit même de *nommer* un placement d'ordre dans `src/adapters/`. | 1) Lectures réelles, **aucune écriture nulle part** — ni `decisions`, ni `snapshots`, ni ping ; tout est journalisé. Le mock d'exécution attend la phase 3. 2) Lectures mockées sur fixture, sortie journalisée. 3) Repousser `DRY_RUN` en phase 3 et ne livrer que `workflow_dispatch`. | R5 |
| **D10** | **Le rapport Brevo part-il en `DRY_RUN` ?** C'est la sortie la plus utile pour juger une modification de bandes, et c'est aussi un mail de plus dans la boîte de l'opérateur pendant son mois d'observation. | 1) Oui, avec un objet qui dit `DRY_RUN` sans ambiguïté. 2) Non : la sortie est le journal du run, lisible dans Actions. | R5 |
| **D11** | **Où s'exécute un `DRY_RUN` ?** Dans le runner, il faudrait recopier **les dix variables secrètes** du job dans GitHub, sur un dépôt public. Chez Scaleway, elles ne bougent pas. | 1) Chez Scaleway : la chaîne démarre la définition du job avec une variable de plus, puis suit le run. 2) Dans le runner : dix secrets GitHub supplémentaires. | R6 |

**D2 mérite l'attention particulière**, comme D1 en phase 1 : ce n'est pas une
question ouverte, c'est un trou déjà présent. `make test` ignore vingt tests
**sans le dire**, et parmi eux ceux qui prouvent que l'index unique refuse un
doublon. Une porte CI qui reprend `make test` tel quel hérite du trou et le rend
invisible derrière une pastille verte.

---

## Lots

### R1 — La porte `test`

- Dépend de : rien. Premier lot de la phase.
- Décisions préalables : **D1, D2, D3**.
- Catégorie d'audit : **garde-fou** → mutation **+** affirmation / variantes / sondes.
- Diff estimé compté : **~750 lignes**.
- Généré exclu : lockfile si D2 = 2 ou si le garde-fou prend une dépendance YAML.
- Fichiers prévus : `.github/workflows/ci.yml`, `test/ci/workflow.test.ts`,
  `docs/integration-continue.md`, `Makefile`.

**Résultat** : chaque poussée et chaque PR exécutent la porte du dépôt, seuil de
couverture de `risk.ts` compris, et le résultat est visible sur la PR.

Le job `test` exécute la vérification du dépôt telle que D1 la tranche. Il
exécute **`make coverage` et non `make test`** : la couverture rejoue toute la
suite *et* fait respecter les 100 % de `src/core/risk.ts`, que le §10 nomme
explicitement. Exécuter les deux paierait la suite deux fois ; n'exécuter que
`make test` donnerait une garantie strictement plus faible que celle que le §10
demande.

Le garde-fou `test/ci/workflow.test.ts` lit les workflows livrés et asserte ce
qu'ils affirment : que `build` dépend de `test`, que `deploy` dépend de `build`,
qu'aucun `latest` n'apparaît, qu'aucune ligne ne prononce `drizzle-kit`,
`db-push` ni `db:push`, et que la plateforme demandée est `linux/amd64`. C'est
ce qui rend la preuve par mutation possible sur du YAML : retirer `needs: test`
doit faire rougir la suite du poste, pas seulement la chaîne.

**Critères de validation** : la chaîne passe au vert sur sa propre PR ;
`make check` passe sur le poste ; le garde-fou échoue si l'on retire
`needs: test`, si l'on remplace `make coverage` par `make test`, ou si l'on
écrit `drizzle-kit` dans un workflow — les trois mutations sont appliquées,
constatées et restaurées dans le rapport.

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
   4 dans `test/adapters/schema-contraintes.test.ts`. Voir D2. Quelle que soit la
   réponse, `docs/integration-continue.md` écrit noir sur blanc ce que la porte
   **ne** couvre **pas**.
3. **Le jeton du workflow.** Dépôt public : `permissions: contents: read` et rien
   d'autre sur ce job. Le défaut du dépôt est plus large.
4. **Les exécutions superposées.** Un `concurrency` par référence, qui annule la
   précédente, évite qu'une rafale de poussées ne fasse tourner cinq suites.
5. **Le cache.** Sous D1 = 1, l'image Compose est reconstruite à chaque run si
   rien ne la met en cache : c'est la différence entre trois et huit minutes.

**Point de redécoupe prévu** : si le lot dépasse, le garde-fou
`test/ci/workflow.test.ts` part en **R1b** et R1a livre le workflow seul. C'est
la coupure la plus propre : elle laisse une PR entièrement YAML et une PR
entièrement TypeScript.

---

### R2 — L'image construite, vérifiée et poussée par la chaîne

- Dépend de : **R1** fusionné.
- Décisions préalables : **D4, D5, D6**.
- Catégorie d'audit : **secret** → mutation **+** affirmation / variantes / sondes.
- Diff estimé compté : **~800 lignes**.
- Fichiers prévus : `.github/workflows/ci.yml` (job `build`),
  `docs/integration-continue.md`, `test/ci/workflow.test.ts`,
  `scripts/build-image.sh` si D4 l'impose, `docs/deploiement.md` §9.

**Résultat** : un commit de `main` produit dans le registry privé une image
taguée par **son** SHA, vérifiée par `scripts/verifier-image.sh`, et **rien
d'autre ne change en production**.

Le job réutilise les deux scripts du dépôt : il construit avec
`scripts/build-image.sh`, vérifie avec `scripts/verifier-image.sh`, puis se
connecte et pousse. Il **ne refait ni la vérification d'architecture ni le
contrôle du SHA embarqué** : ils existent, ils sortent en 1, et les recopier
dans du YAML créerait une seconde définition libre de diverger.

Prérequis opérateur, à poser avant le dispatch : l'application IAM dédiée, sa
policy **limitée à `ContainerRegistryFullAccess` et `ServerlessJobsFullAccess`**,
et les secrets de D5. La documentation les nomme ; elle ne porte aucune valeur.

**Critères de validation** : une poussée sur `main` produit
`rg.fr-par.scw.cloud/<namespace>/ubac:<sha>` ; `docker buildx imagetools inspect`
sur l'image **poussée** montre `linux/amd64` **et aucune autre plateforme** ; le
journal public ne contient la clé secrète sous aucune forme ; le garde-fou échoue
si un `latest` apparaît dans un workflow.

**Pièges connus.**

1. **Le SHA du commit de fusion.** Sur un événement `pull_request`,
   `actions/checkout` place HEAD sur le commit de fusion. `build-image.sh` lit
   `git rev-parse HEAD` : l'image serait taguée par un commit qui disparaît après
   le merge, et `decisions.git_sha` désignerait l'introuvable. C'est le motif de
   D4, et c'est la panne la plus coûteuse de ce lot parce qu'elle ne se voit
   qu'une fois qu'on cherche à relire une décision douteuse.
2. **Les manifestes d'attestation de buildx.** Constaté sur ce poste : une
   construction buildx ordinaire émet un `exporting attestation manifest` et une
   `manifest list` là où on n'attend qu'une image. Si ces attestations
   accompagnent la poussée — **à vérifier sur le registry, pas à supposer** —
   `docker buildx imagetools inspect` montrera une entrée supplémentaire, et
   `docs/deploiement.md` §5 demande de voir « une ligne `Platform: linux/amd64`,
   et aucune autre plateforme ». Le lot constate ce que le registry répond, puis
   tranche : soit la construction pose `--provenance=false`, soit la
   documentation est corrigée. L'un ou l'autre, jamais ni l'un ni l'autre.
3. **`--load` puis `push`.** `verifier-image.sh` fait *tourner* l'image : elle
   doit donc être dans le démon local, pas seulement dans le registry. Un
   `--push` direct sauterait les dix contrôles, y compris ceux qui prouvent que
   le graphe ESM se résout.
4. **Le mot de passe dans la ligne de commande.** `--password-stdin`, comme le
   fait déjà `docs/deploiement.md` §5. Actions masque les secrets dans ses
   journaux, mais un `set -x` ou une trace de `docker` recopient la valeur, et le
   journal est public.
5. **L'arbre sale.** `build-image.sh` refuse un arbre sale et n'a pas de drapeau
   pour passer outre. Une étape qui écrirait un fichier avant la construction —
   un cache, un rapport, un fichier de version — ferait échouer le lot pour une
   raison qui n'a rien à voir avec l'image.

**Point de redécoupe prévu** : **R2a** construction + vérification, sans
connexion ni poussée (l'artefact reste dans le runner) ; **R2b** connexion,
poussée et contrôle du manifeste poussé. La coupure isole exactement la partie
qui manipule le secret.

---

### R3 — Le déploiement, sous environnement protégé

- Dépend de : **R2** fusionné.
- Décisions préalables : **D7, D8**.
- Catégorie d'audit : **secret + argent + garde-fou** → mutation **+** audit complet.
- Diff estimé compté : **~800 lignes**.
- Fichiers prévus : `.github/workflows/ci.yml` (job `deploy`),
  `docs/integration-continue.md`, `docs/deploiement.md`,
  `test/ci/workflow.test.ts`.

**Résultat** : un déploiement approuvé repointe la définition du job Scaleway sur
le nouveau tag, **relit la définition** pour le prouver, et laisse le cron, le
timeout, les tentatives et les dix variables secrètes exactement où ils étaient.

La relecture n'est pas une précaution de confort : c'est le seul contrôle qui
existe entre le déploiement et 7 h du matin. Elle asserte, après la mise à jour,
que `image-uri` vaut le tag attendu **et** que `cron.schedule`, `cron.timezone`,
`job-timeout`, `max-retries`, `memory-limit` et `cpu-limit` valent encore ce que
`docs/deploiement.md` §6 fige. Un déploiement qui réussit et qui a effacé le cron
est indistinguable d'un déploiement réussi, jusqu'au lendemain matin.

Le job écrit dans son journal **le tag précédent** avant de le remplacer : c'est
la commande de retour en arrière, rendue disponible au moment où elle est utile
plutôt que reconstituée dans l'urgence.

**Critères de validation** : le déploiement attend l'approbation prévue par D7 ;
après un déploiement, la définition lue chez Scaleway porte le nouveau tag et les
six réglages inchangés ; le journal porte le tag précédent ; **le run du
lendemain matin conclut** — updown en `UP` avec `RUN_CONCLU`, quatre lignes de
`decisions` dont le `git_sha` égale le nouveau tag.

**Pièges connus.**

1. **Les noms d'arguments du CLI `scw` ne sont pas vérifiés.**
   `docs/deploiement.md` §6 le dit déjà pour la création ; c'est vrai aussi pour
   la mise à jour et la lecture. Le lot les confirme avec
   `scw jobs definition update -h` **avant** de les écrire, et le rapporte.
2. **Mise à jour partielle contre remplacement.** Il n'est pas acquis qu'une mise
   à jour ne modifiant que `image-uri` laisse les autres champs intacts. C'est
   exactement ce que la relecture existe pour constater — et la raison pour
   laquelle elle asserte six réglages et pas seulement le tag.
3. **La fenêtre de 7 h UTC.** Un déploiement pendant le run quotidien ne tue pas
   le conteneur en cours, mais un déploiement *cassé* juste avant coûte une
   journée d'observation. Avec D7 = 1, l'approbation humaine est le garde-fou ;
   avec D7 = 2, le lot doit dire ce qui se passe entre 06 h 45 et 07 h 15 UTC.
4. **L'environnement protégé dépend de la visibilité du dépôt.** Les règles de
   protection d'environnement sont gratuites sur un dépôt **public**. Si le dépôt
   passait un jour en privé sans forfait payant, elles cesseraient d'être
   appliquées — sans que le workflow change d'une ligne. À écrire dans les
   limites déclarées.
5. **Aucune migration ici.** Le job `deploy` ne touche pas à la base. C'est R4
   qui rend ce silence vérifiable.

**Point de redécoupe prévu** : **R3a** le job `deploy` et l'environnement ;
**R3b** la relecture des six réglages et le tag précédent journalisé.

---

### R4 — La barrière de migration

- Dépend de : **R3** fusionné.
- Décision préalable : aucune. La règle existe déjà (`docs/base-de-donnees.md`
  §5) ; ce lot la rend opposable à la chaîne.
- Catégorie d'audit : **garde-fou** → mutation **+** audit complet.
- Diff estimé compté : **~500 lignes**.
- Fichiers prévus : `.github/workflows/ci.yml` (étape de `deploy`),
  `docs/integration-continue.md`, `docs/base-de-donnees.md`,
  `test/ci/workflow.test.ts`.

**Résultat** : **la chaîne ne migre jamais, et refuse de déployer une migration
qu'elle ne peut pas prouver appliquée.**

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
passe sans rien demander. Les quatre cas sont des sondes distinctes, et la
mutation à appliquer est le retrait de la comparaison.

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

**Point de redécoupe prévu** : aucun. Ce lot est déjà à la taille d'une coupure.

---

### R5 — Le mode `DRY_RUN` dans le code

- Dépend de : **PR #45 fusionnée** (croise `src/jobs/`). Indépendant de R1 à R4.
- Décisions préalables : **D9, D10**.
- Catégorie d'audit : **garde-fou + argent** → mutation **+** audit complet.
- Diff estimé compté : **~800 lignes**.
- Fichiers prévus : `src/config/env.ts`, un module de ports de lecture seule dans
  `src/adapters/`, `src/jobs/daily-main.ts`, `test/config/env.test.ts`,
  `test/jobs/purete.test.ts`, un test dédié, `docs/run-quotidien.md`,
  `docs/mode-dry-run.md`.

**Résultat** : la même image, démarrée avec une variable de plus, lit la réalité
du jour et **n'écrit nulle part** — ni décision, ni photo, ni ping — puis le dit
dans son journal.

**Pièges connus. Le premier est le plus grave de toute la phase.**

1. **Un `DRY_RUN` qui écrit détruit la journée d'observation.** L'idempotence de
   `decisions` vient de l'index unique, qui rend `ALREADY_RECORDED` à la seconde
   écriture : un essai lancé le matin occuperait les quatre lignes du jour, et le
   run de 7 h enregistrerait « déjà présent » — la décision conservée serait
   celle de l'essai, éventuellement calculée avec des bandes modifiées. Et
   `snapshots` est pire : sa clé primaire **remplace** la ligne du jour au lieu
   de la refuser. La non-écriture n'est donc pas une propriété de confort du mode
   `DRY_RUN`, c'est sa raison d'être.
2. **Un `DRY_RUN` ne doit jamais pinguer le healthcheck.** Le §9 est explicite :
   « la surveillance ne doit pas dépendre du système surveillé ». Un essai qui
   pingue rendrait updown vert alors que le run réel est mort — c'est-à-dire
   exactement la panne que la surveillance existe pour voir.
3. **Le mock d'exécution ne peut pas être écrit aujourd'hui.** La règle ESLint de
   `docs/phase-1-frontieres.md` refuse tout nom dénotant un placement, une
   annulation ou un retrait dans `src/adapters/**` et `src/jobs/**`, **y compris
   dans une chaîne de caractères et un littéral de gabarit**. Un mock qui
   journalise « `createOrder` BTC-USDC … » ne passe pas le lint. Ce n'est pas un
   obstacle à contourner : tant que la phase 1 tient, il n'y a rien à mocker, car
   l'adapter Coinbase n'expose aucune écriture. C'est l'argument décisif de D9 —
   le mock qui journalise appartient à la phase 3, avec le déplacement du
   garde-fou.
4. **Le drapeau entre par `src/config/env.ts`, et par lui seul.** `A18` interdit
   à tout module de `src/jobs/` de lire l'environnement, `A16` ouvre la seule
   porte. Un `process.env['UBAC_DRY_RUN']` dans `daily-main.ts` tombe sur le
   garde-fou.
5. **`A22` : rien n'importe `daily-main.ts`**, ni dans `src/`, ni dans `test/` —
   et ce module **lance le run à l'évaluation**. La substitution des ports ne peut
   donc pas vivre uniquement dans le point d'entrée, sinon elle n'a aucune sonde.
   Elle vit dans un module importable ; `daily-main.ts` ne fait que choisir.

**Critères de validation** : un run en `DRY_RUN` sur une base peuplée n'écrit
aucune ligne de `decisions` et ne remplace aucune photo — constaté sur la base
jetable, pas déduit du code ; il ne pingue pas le healthcheck ; il journalise le
mode en première ligne, comme le fait déjà la déclaration du canal ntfy ouvert ;
un run ordinaire est inchangé, les 1 128 tests compris. Mutation à appliquer :
retirer la substitution des ports et constater que les sondes d'écriture rougissent.

**Point de redécoupe prévu** : **R5a** le drapeau dans `env.ts` et les ports de
lecture seule, avec leurs sondes ; **R5b** la ligne de journal, le sort du
rapport (D10) et la documentation.

---

### R6 — `workflow_dispatch`, et le rejeu déclenché depuis la chaîne

- Dépend de : **R3** et **R5** fusionnés.
- Décision préalable : **D11**.
- Catégorie d'audit : **secret** → mutation **+** audit complet.
- Diff estimé compté : **~600 lignes**.
- Fichiers prévus : `.github/workflows/dry-run.yml`,
  `docs/integration-continue.md`, `docs/mode-dry-run.md`,
  `test/ci/workflow.test.ts`.

**Résultat** : l'opérateur démarre un essai depuis l'onglet Actions ; l'essai
tourne **là où les secrets vivent déjà**, sur l'image déployée, et la chaîne
rapporte son code de sortie et son journal.

Sous D11 = 1, la chaîne ne gagne **aucun secret** : elle démarre la définition du
job existante avec la variable de `DRY_RUN` en plus, avec les mêmes identifiants
IAM que le déploiement. C'est le point qui justifie ce choix sur un dépôt public :
recopier `DATABASE_URL`, les clés Coinbase et la clé Brevo dans GitHub ferait
passer les secrets de la chaîne de deux à douze, et ajouterait un second endroit
d'où ceux du job peuvent sortir — pour une fonctionnalité de confort.

**Critères de validation** : le déclenchement manuel démarre un run `DRY_RUN` et
rien d'autre ; **aucun chemin du workflow ne permet de démarrer un run réel** —
l'entrée est requise et sans valeur par défaut permissive ; la base est inchangée
après l'essai ; le healthcheck n'a pas été pingé ; le journal du run est lisible
depuis Actions.

**Pièges connus.**

1. **Le déclencheur qui démarre un vrai run.** Une entrée `DRY_RUN` dont le
   défaut est `false` fait qu'un clic distrait démarre un run **réel**, hors
   cron, qui écrira la journée. L'entrée est donc requise et sans défaut
   permissif, et le garde-fou de workflow porte une sonde sur ce point.
2. **Les surcharges d'environnement à l'exécution ne sont pas vérifiées.** Il
   n'est pas acquis que `scw` permette de démarrer une définition avec une
   variable supplémentaire sans modifier la définition elle-même. Si ce n'est pas
   le cas, l'alternative est une **seconde définition de job**, sans cron, pointée
   sur la même image — et alors la modifier ne touche jamais la définition
   quotidienne, ce qui est plus sûr. À trancher au dispatch, sur ce que le CLI
   répond réellement.
3. **Deux runs simultanés.** Un essai lancé à 7 h 00 UTC croise le run du cron.
   Aucun des deux n'écrit pour l'autre — l'essai n'écrit rien — mais les deux
   parlent à Coinbase. Sans conséquence, à dire plutôt qu'à supposer.

**Point de redécoupe prévu** : aucun. Si le piège 2 impose une seconde
définition, c'est un changement d'infrastructure à faire remonter au coordinateur,
pas un redécoupage.

---

### R7 — La clôture : ce que la chaîne fait, ce que le poste garde

- Dépend de : **R6** fusionné.
- Décision préalable : **D8**.
- Catégorie d'audit : **mutation seule**. Aucun secret, aucune écriture, aucun
  garde-fou : c'est le seul lot de la phase dans ce cas.
- Diff estimé compté : **~300 lignes**.
- Fichiers prévus : `docs/deploiement.md`, `docs/integration-continue.md`,
  `docs/plans/ubac-phase-2.md`, `AGENTS.md` si l'opérateur le veut.

**Résultat** : `docs/deploiement.md` §9 ne promet plus la phase 2, et le partage
du travail entre la chaîne et le poste est écrit une fois pour toutes :

| Geste | Qui |
|---|---|
| Tester, construire, vérifier, pousser | la chaîne |
| Déployer | la chaîne, après approbation (D7) |
| **Migrer** | **le poste, toujours** |
| Rejouer en `DRY_RUN` | la chaîne, exécution chez Scaleway |
| Reprendre la main si GitHub est indisponible | le poste, selon D8 |

À vérifier au passage : `AGENTS.md` annonce encore « le projet est actuellement
en phase 0 ». C'est faux depuis la clôture de la phase 0 ; le corriger relève de
l'opérateur, pas d'un lot technique.

**Critères de validation** : aucune affirmation de `docs/deploiement.md` ne
contredit la chaîne livrée ; les commandes citées sont celles qui existent ;
`make check` passe.

**Point de redécoupe prévu** : aucun. Candidat à la fusion dans R6 si le
coordinateur préfère six lots.

---

## Couverture des exigences de la spec

| Exigence du §10 | Lot |
|---|---|
| `test` bloquant, **couche risque incluse** | R1 (via `make coverage`) |
| `test` réellement **bloquant** sur `main` | R1 (D3) |
| `build` dépend de `test` (`needs:`) | R2 |
| `deploy` dépend de `build` | R3 |
| `deploy` sur **environnement protégé** | R3 (D7) |
| Login registry : `nologin` + clé secrète Scaleway | R2 (D5) |
| **Tag par SHA de commit, jamais `latest`** | R2 (D4), asserté par le garde-fou de R1 |
| Application IAM dédiée, policy limitée aux deux droits | R2 (D5), prérequis opérateur |
| `workflow_dispatch` avec drapeau `DRY_RUN` | R6 (D11) |
| `DRY_RUN` : même image, adapter remplacé par un mock qui journalise | R5 (D9) — **forme adaptée à la phase 2**, voir le piège 3 de R5 |
| Build explicitement `linux/amd64` | **acquis** (`Dockerfile.prod`, `build-image.sh`), vérifié par R2 |
| Architecture prouvée après coup | **acquis** (`verifier-image.sh`), appelé par R2 |
| Registry privé, namespace `fr-par` | **acquis** (phase 1, Q9) |
| Neon eu-central-1, chaîne pooled | **acquis** (phase 1, Q2) |
| Job 256 Mo / 0,1 vCPU / timeout 5 min / retries 0 / cron | **acquis** (Q9), **protégé** par la relecture de R3 |
| Dix variables secrètes chez Scaleway | **acquis** (Q9), **non recopiées** dans GitHub (R6, D11) |
| Migrations : depuis le poste, jamais depuis une CI | R4 |
| SHA persisté dans `decisions`, traçabilité d'une décision douteuse | **acquis** (Q9) ; R2 en préserve la condition, R3 en journalise le tag précédent |
| Retour en arrière par repointage du tag | **acquis** (`docs/deploiement.md` §8) ; R3 en rend la commande disponible |

Aucune exigence du §10 n'est laissée sans lot ni sans acquis.

## Ordre, concurrence et sérialisation

**Cette phase se parallélise mal, et il faut le dire.** Sept lots pour deux
fichiers de workflow : R1, R2, R3 et R4 écrivent tous dans `.github/workflows/`
et dans `test/ci/workflow.test.ts`. Le `needs:` que le §10 exige impose un
**workflow unique** pour `test` → `build` → `deploy` ; le contourner par un
`workflow_run` coûterait plus cher que le parallélisme gagné — il ne s'affiche
pas sur les PR, ne bloque pas un merge, et s'exécute dans la version de la
branche par défaut.

| Vague | Lots | Workers |
|---|---|---|
| 1 | **R1** seul | 1 |
| 2 | **R2** et **R5** | 2 |
| 3 | **R3** (R5 peut courir encore) | 1 à 2 |
| 4 | **R4** | 1 |
| 5 | **R6** | 1 |
| 6 | **R7** | 1 |

- **R5 est le seul lot réellement parallèle** : il écrit dans `src/` et `test/`,
  la chaîne écrit dans `.github/` et `docs/`. Aucun fichier commun.
- **Le plafond de trois workers n'est jamais atteint.** Ce n'est pas un défaut de
  découpage : c'est la forme de l'objet. Une chaîne est un artefact unique.
- **Fichiers à sérialiser** même sans dépendance métier :
  `.github/workflows/ci.yml`, `test/ci/workflow.test.ts`,
  `docs/integration-continue.md`, `docs/deploiement.md`.
- **PR #45 d'abord** : fusionnée avant R5. Si elle est encore en vol après R1,
  la rebaser sur `main` pour qu'elle serve de premier passage réel de la porte.

## La continuité du mois d'observation

Le mois d'observation de la phase 1 court pendant toute cette phase. La règle
tient en une phrase : **rien de ce qui est construit ici ne touche la production
avant R3**, et R3 est sous approbation.

1. **R1, R2, R4, R5 ne modifient pas la définition du job.** Tant qu'ils sont en
   vol, la production tourne sur l'image déployée à la main au commit `5caf8a9`,
   inchangée.
2. **R3 est le premier lot qui peut casser un matin.** Sa relecture des six
   réglages et son journal du tag précédent existent pour cela.
3. **Après chaque déploiement, le run du lendemain est un critère**, pas une
   observation optionnelle : updown en `UP` avec `RUN_CONCLU`, quatre lignes de
   `decisions` portant le nouveau `git_sha`.
4. **R5 est le lot dont un défaut serait silencieux** : un `DRY_RUN` qui écrit ne
   casse rien visiblement, il remplace une journée d'observation par un essai.
   C'est la raison de son audit complet.
5. **Le retour en arrière reste gratuit** : repointer la définition sur le tag
   précédent, comme aujourd'hui. Aucune image n'est jamais écrasée, parce
   qu'aucune ne s'appelle `latest`.

## Ce que cette phase ne garantira pas

À écrire dans `docs/integration-continue.md` plutôt qu'à laisser croire :

- La porte `test` ne couvre pas la base tant que **D2 = 1** : vingt tests, dont
  ceux de l'index unique, restent une porte du poste.
- Le garde-fou de workflow lit **ce que les fichiers disent**, pas ce que GitHub
  exécute. Il ne voit pas un contrôle requis retiré dans les réglages du dépôt,
  ni une règle d'environnement modifiée à la console.
- La barrière de migration compare **un fichier**. Un changement de schéma
  introduit ailleurs lui échappe.
- Les règles de protection d'environnement dépendent de la **visibilité publique**
  du dépôt.
- Aucun de ces contrôles ne remplace la garantie structurelle de la phase 1 : une
  clé d'API sans permission de trade.

## Sur la durée annoncée

Le §13 annonce « une soirée » pour la phase 2. La phase 0 l'a démenti pour son
propre périmètre, la phase 1 aussi, et la phase 2 est faite **entièrement** de
frontières externes — celles-là mêmes sur lesquelles les estimations de la
phase 1 se sont trompées d'un facteur 2 à 3. Sept lots, onze décisions préalables,
six lots en audit complet : aucune estimation en soirées n'est donnée ici. Les
temps réels se mesurent pendant les cycles Orca, comme en phase 1.
