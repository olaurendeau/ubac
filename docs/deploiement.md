# Déploiement

La procédure **manuelle** de mise en production du run quotidien, exécutable
depuis le poste. Spec §10, lot Q9 de la phase 1.

L'hébergement et l'ordonnancement étaient prévus en phase 2. L'opérateur a levé
ce report le 2026-09-15 pour eux seuls : un lancement manuel chaque matin est le
maillon qui casserait en premier — un jour oublié est une journée d'observation
perdue, et le healthcheck ne distinguerait pas un job mort d'un opérateur
endormi. **La chaîne GitHub Actions du §10 reste en phase 2** : build et
déploiement se font à la main, comme les migrations. Les deux scripts de ce
dépôt construisent et interrogent ; ils ne poussent ni ne déploient.

## 1. Prérequis

**Sur le poste** : `docker` avec `buildx`, `git`, et le CLI `scw` ou la console
Scaleway. Ni Node, ni npm, ni Python — c'est volontaire (AGENTS.md).

**Chez Scaleway** : un Container Registry **privé** dans le namespace `fr-par`,
et une application IAM dédiée dont la policy se limite à
`ContainerRegistryFullAccess` et `ServerlessJobsFullAccess`.

**Ailleurs** : un projet Neon en **AWS eu-central-1**, chaîne *pooled* ; un check
updown.io ; un topic ntfy.

### Les onze variables secrètes du job

`src/config/env.ts` fait foi, pas le §10 : la spec en fige six, le dépôt en
requiert **onze**. Quatre écarts sont motivés dans
[alertes.md](alertes.md) section 1 et
[rapport-quotidien.md](rapport-quotidien.md) section 8 ; la onzième,
`COINBASE_PORTFOLIO_UUID`, est exigée par E6 de la phase 3.

| Variable | Forme exigée au démarrage |
|---|---|
| `DATABASE_URL` | URL `postgres://` ou `postgresql://` |
| `COINBASE_API_KEY` | non vide |
| `COINBASE_API_SECRET` | non vide |
| `COINBASE_PORTFOLIO_UUID` | l'UUID du portefeuille dédié, en minuscules, tel que `key_permissions` le rend |
| `BREVO_API_KEY` | non vide |
| `BREVO_SENDER` | une adresse, sur le domaine authentifié SPF et DKIM |
| `BREVO_RECIPIENT` | une adresse, sans nom d'affichage ni virgule |
| `NTFY_URL` | URL `https://` |
| `NTFY_TOPIC` | `[A-Za-z0-9_-]`, 64 au plus |
| `NTFY_TOKEN` | un jeton porteur, **ou** la sentinelle ci-dessous |
| `HEALTHCHECK_URL` | URL `https://` |

Une manquante arrête le démarrage, et le message **nomme la variable sans jamais
citer sa valeur**. Elles sortent toutes du même appel : onze variables fautives
donnent onze lignes, pas onze redémarrages.

### `COINBASE_PORTFOLIO_UUID` : à poser **avant** de déployer

**C'est ce qui casse un matin.** L'image qui l'exige refuse de démarrer sans
elle, et le run du lendemain ne part plus — d'une façon qui ressemble à une panne
de la clé. Ordre à tenir : poser la variable chez Scaleway, **puis** pousser
l'image.

La valeur est l'UUID que `GET /api/v3/brokerage/key_permissions` rend pour la
clé **et** que l'opérateur a reconnu comme celui du portefeuille dédié
([cle-coinbase.md](cle-coinbase.md), étape 4). Ce n'est pas un secret — il
n'ouvre rien —, mais il identifie le portefeuille : il vit chez Scaleway et se
rapporte dans Orca, **jamais dans un fichier versionné**.

Chaque run journalise la clé telle qu'elle est, avant tout le reste :

```
cle coinbase — portefeuille=<uuid> attendu=oui can_view=true can_trade=false can_transfer=false
```

Une clé scopée sur un autre portefeuille donne `attendu=NON`, puis le refus à
l'étape 1 : alerte `JOB_FAILED`, sortie en 1, **rien d'autre lu, rien décidé ni écrit**.

### `NTFY_TOKEN` : le canal ouvert se déclare

Le topic de l'opérateur vit sur ntfy.sh, public et sans liste de contrôle
d'accès. Il n'y a pas de jeton à poser, et celui qu'un compte gratuit
délivrerait n'achèterait presque rien : la réservation de topic, qui seule
fermerait le canal, est une option payante.

**Décision de l'opérateur du 2026-09-16** : le canal reste ouvert, et le système
le **dit** plutôt que de faire semblant d'être authentifié.

```sh
NTFY_TOKEN=CANAL-PUBLIC-SANS-JETON
```

Cette valeur, à la lettre près, déclare le canal non authentifié : le job publie
alors ses alertes **sans en-tête `Authorization`**. Toute autre valeur est lue
comme un jeton porteur. `NTFY_TOKEN` absente, vide ou blanche reste **refusée au
démarrage**, exactement comme avant — la sentinelle ajoute une façon de
déclarer, elle n'en retire aucune. Une sentinelle mal orthographiée — casse,
espace de copier-coller — est refusée elle aussi, plutôt que d'être prise pour
un jeton qui vaudrait un 401 quotidien.

**Le run le redit tous les jours**, en première ligne de son journal, avant tout
appel de port. L'écart porte une échéance : [alertes.md](alertes.md) § 5 bis.

### La condition de réception du healthcheck

Le check updown doit porter la **chaîne recherchée `RUN_CONCLU`** : sans elle, le
corps du pulse n'est pas inspecté et un run abandonné passerait pour un succès.
Le code ne peut pas le vérifier ([healthcheck.md](healthcheck.md) section 2).

## 2. Les migrations, avant le déploiement et depuis le poste

> ### ⚠ Lire [base-de-donnees.md](base-de-donnees.md) section 5 avant la première migration
>
> `drizzle-kit push` liste ses instructions destructrices **puis les exécute**.
> La confirmation n'existe que sur un terminal interactif : sans TTY, un
> `DROP TABLE … CASCADE` passe sans question, et le seul témoin est une ligne de
> log que personne ne lit.

**L'image de production n'embarque pas `drizzle-kit`** — la seule forme de
garantie qui ne repose pas sur la discipline : un job qui ne l'a pas ne peut pas
le lancer, même sur une ligne recopiée par erreur dans sa définition.
`./scripts/verifier-image.sh` le contrôle nommément.

Le schéma s'applique donc **avant** de déployer, depuis un terminal, avec le SQL
sous les yeux :

```sh
DATABASE_URL='postgresql://…' docker compose run --rm --no-deps \
  -e DATABASE_URL dev npm run db:push
```

`--no-deps` évite de réveiller le Postgres local ; `docker compose run` alloue un
TTY, donc la confirmation apparaît. La chaîne vient du `.env` du poste ou de
l'interface Neon — **jamais du dépôt**. `make db-push` vise la base de
développement, pas Neon : il recopie `UBAC_DEV_DATABASE_URL`.

## 3. Construire l'image

```sh
./scripts/build-image.sh rg.fr-par.scw.cloud/<namespace>/ubac
```

Le script refuse de partir sur un **arbre de travail sale** — l'image serait
taguée par un SHA qui ne la décrit pas — et il n'y a pas de drapeau pour passer
outre. Il affiche la commande avant de la lancer :

```
+ docker buildx build --platform linux/amd64 --build-arg GIT_SHA=<sha> \
    -f Dockerfile.prod -t rg.fr-par.scw.cloud/<namespace>/ubac:<sha> --load .
```

**Ce qu'il faut voir** : `naming to …/ubac:<sha>`, puis
`image construite : …:<sha>`. **Aucun tag `latest` n'apparaît nulle part**, et
c'est le point : le SHA est persisté dans `decisions`, donc on doit pouvoir dire
quelle image tournait le jour d'une décision douteuse. Un `latest` qui bouge
efface exactement cette réponse.

### Le piège de l'architecture, et comment il est fermé

Une image ARM construite sur ce Mac meurt sur Scaleway en `exec format error`, à
7 h du matin, sans que rien dans la construction n'ait rougi. `Dockerfile.prod`
refuse donc de se construire pour autre chose que `linux/amd64` :

```
ARCHITECTURE REFUSEE : TARGETPLATFORM="linux/arm64", attendu linux/amd64.
```

La panne du matin devient un échec immédiat sur le poste. Le `--platform` de la
ligne de commande reste écrit explicitement : le garde-fou est un filet, pas la
consigne.

## 4. Vérifier l'image avant de la pousser

```sh
./scripts/verifier-image.sh rg.fr-par.scw.cloud/<namespace>/ubac:<sha>
```

**Ce qu'il faut voir** — dix lignes, toutes en `OK` :

```
OK    architecture de l'image
OK    SHA embarque == tag de l'image
OK    aucune devDependency dans node_modules
OK    drizzle-kit absent de l'image
OK    ni tsx ni tsc dans node_modules/.bin
OK    aucun .ts dans dist/
OK    utilisateur non privilegie
OK    code de sortie sans configuration
OK    refus de configuration en nommant la variable
OK    le point d’entree passe run_date, at et git_sha

tous les controles passent — l'image peut etre poussee.
```

Le script sort en **1 par contrôle en échec** et dit `NE PAS POUSSER` ; il
n'affirme rien, il interroge l'image et affiche ce qu'elle répond, écart compris.

Les trois derniers contrôles font **tourner** l'image, sans variable et
`--network none`. Le point d'entrée doit aller jusqu'à `loadConfig()` et refuser
en nommant `DATABASE_URL` : c'est la preuve que tout le graphe ESM se résout —
ccxt, pg, drizzle-orm, zod — et que le script d'entrée fabrique bien ses dates,
sans qu'aucun réseau n'ait été disponible pour y arriver.

## 5. Pousser

Le mot de passe est la **clé secrète** de l'application IAM, et il entre par
l'entrée standard : recopié dans la ligne de commande, il finirait dans
l'historique du shell.

```sh
docker login rg.fr-par.scw.cloud -u nologin --password-stdin
docker push rg.fr-par.scw.cloud/<namespace>/ubac:<sha>
```

### Vérifier l'architecture de l'image **poussée**

La section 4 a inspecté l'image locale. Ce contrôle-ci lit le manifeste **du
registre**, donc ce que Scaleway ira réellement chercher :

```sh
docker buildx imagetools inspect rg.fr-par.scw.cloud/<namespace>/ubac:<sha>
```

**Ce qu'il faut voir** : une ligne `Platform: linux/amd64`, et aucune autre
plateforme. Une entrée `Platform: unknown/unknown` annotée
`vnd.docker.reference.type: attestation-manifest` n'en est pas une : c'est
l'attestation que buildx joint à l'image. C'est la dernière occasion de voir le piège avant qu'il ne coûte une
journée d'observation.

## 6. Créer le job

Valeurs du §10, sans marge de manœuvre.

| Réglage | Valeur | Motif |
|---|---|---|
| Image | `…/ubac:<sha>` | jamais `latest` (section 3) |
| Mémoire | 256 Mo | |
| vCPU | 0,1 | |
| Timeout | 5 min | |
| **Tentatives max** | **0** | un retry après un timeout partiel pourrait doubler une jambe ; `client_order_id` protège, mais on ne dépend pas d'une seule ligne de défense |
| Cron | `0 7 * * *`, **UTC** | les bougies daily closent à 00:00 UTC : pas de changement d'heure |
| Variables **secrètes** | les onze de la section 1 | secrètes, pas ordinaires : la console masque alors leur valeur |

**Aucun argument n'est à ajouter à la commande du job** : le point d'entrée de
l'image fabrique `--run-date`, `--at` et `--git-sha` lui-même, ce dernier depuis
le SHA scellé à la construction. Le tag de l'image et `decisions.git_sha` ne
peuvent donc pas diverger.

> Les noms d'arguments du CLI `scw` ci-dessous **n'ont pas été vérifiés contre un
> compte réel** ; les confirmer avec `scw jobs definition create -h` avant de les
> recopier. La console expose les mêmes réglages sous les intitulés du tableau et
> reste le chemin le plus sûr pour la première création.

```sh
scw jobs definition create name=ubac-daily \
  image-uri=rg.fr-par.scw.cloud/<namespace>/ubac:<sha> \
  cpu-limit=100 memory-limit=256 job-timeout=5m \
  cron.schedule="0 7 * * *" cron.timezone=UTC
```

## 7. Le premier run, déclenché à la main

Ne pas attendre 7 h du matin pour découvrir une variable manquante :
`scw jobs definition start <id-de-la-definition>`.

**Ce qu'il faut voir, dans cet ordre** :

1. `ubac: run_date=… at=… git_sha=…` — le point d'entrée a démarré, et le SHA
   est celui du tag ;
2. la ligne du canal ntfy ouvert, si la sentinelle est posée ;
3. `run quotidien — run_date=… portefeuille=… lecture=true` — la clé répond ;
4. `soldes reconcilies (…)`, puis les décisions et le snapshot ;
5. **code de sortie 0**.

Un **1** n'est pas forcément une panne du programme : un abandon de
réconciliation sort en 1, et c'est voulu.
[run-quotidien.md](run-quotidien.md) donne la table complète des codes.

**Puis les trois canaux**, qui sont le vrai produit de ce lot : le rapport Brevo
est arrivé, les alertes éventuelles sont arrivées, et updown.io affiche le check
en `UP` avec `RUN_CONCLU` dans le corps du dernier pulse. Enfin, en base : les
quatre lignes de `decisions` du jour portent un `git_sha` **égal au tag de
l'image** — la propriété que toute la section 3 existe pour garantir, constatée
ici une fois et pas tous les jours.

## 8. Mettre à jour, et revenir en arrière

Une mise à jour est la même procédure depuis le début : commit, build,
vérification, push, définition du job pointée sur le nouveau tag.

**Le retour en arrière est gratuit, et c'est ce que le tag par SHA achète** :
repointer la définition sur le tag précédent suffit, l'image n'ayant jamais été
écrasée. Avec `latest`, il aurait fallu reconstruire depuis un commit qu'on ne
saurait plus nommer.

## 9. Ce que ce lot ne fait pas

- **Aucun déploiement par la chaîne** : depuis le lot R2 de la phase 2, `build`
  construit, vérifie et pousse l'image de chaque commit de `main` et de chaque
  tag `v*` ([integration-continue.md](integration-continue.md) §7), sans jamais
  réécrire une image déjà poussée ; les sections 3 à 5 restent le chemin
  manuel. `deploy` viendra en R3, `workflow_dispatch` et son `DRY_RUN` en
  phase 3.
- **Aucun déploiement automatique** : pousser et déployer sont des gestes de
  l'opérateur.
- **Aucune exécution d'ordre** ([phase-1-frontieres.md](phase-1-frontieres.md)),
  et **aucune migration depuis le job** (section 2).

## 10. Vérifier le dépôt

`make check` et `make coverage`, comme partout ailleurs. Les deux scripts de ce
document ne sont **pas** appelés par la suite de tests : ils parlent à `docker`,
qui n'a pas sa place dans un `vitest run`. Ce qu'ils garantissent se constate en
les exécutant, et la sortie attendue est écrite aux sections 3 et 4.
