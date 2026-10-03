# Le convoyeur : ce que fait l'opérateur

Le convoyeur est l'agent **distinct** d'Ubac qui, chaque soir à 19:00
Europe/Paris, convertit 100 EUR de *Primary* en USDC, les transfère vers
`ubac-agent` et enregistre l'apport dans `cash_flows`
([spec](specs/ubac-convoyeur.md), [plan](plans/ubac-convoyeur.md)). Ce
document est celui de l'opérateur : la clé, la liste blanche, les secrets, le
rôle Neon, le mode, le mois d'octobre et le geste de reprise. Critère **CV18**,
lot Y9.

Rien de ce qui suit ne passe par un agent. **Aucune clé, aucun mot de passe,
aucune chaîne de connexion** n'entre dans le dépôt, dans une conversation ou
dans Orca : on y rapporte des constats.

## 0. Le calendrier

| # | Quand | Geste | Section |
|---|---|---|---|
| **OP1** | **au plus tard le 2026-10-09** | liste blanche activée et vide, clé créée sur *Primary*, rangée hors dépôt | [§2](#2-op1--la-liste-blanche-puis-la-clé) |
| OP3 | avant tout tag qui contient Y4a | `db:push` sur Neon, script du rôle, mot de passe | [§5](#5-op3--le-rôle-neon-et-son-mot-de-passe) |
| OP2 | après OP1 et Y10, avant OP4 | mesures MC1 à MC3 (CV20 à CV22), outil d'Y10 | — |
| OP4 | après Y6, OP3 et OP2 ; le 2026-10-24 au plus tard | définition Scaleway `ubac-convoyeur` à 140 mVCPU, 256 Mio, délai 600 s, aucune tentative ; déclencheur `convoyeur` `0 19 * * *` Europe/Paris **sans argument**, secrets ; variable de forge `SCW_CONVOYEUR_JOB_DEFINITION_ID` | [§4](#4-les-huit-variables-du-convoyeur) |
| OP5 | virement du ~2026-10-27 | `DRY_RUN`, puis le geste manuel une dernière fois | [§7](#7-octobre--le-dry_run-voit-leur-puis-le-geste-manuel) |
| OP6 | après Y7b, Y8, S13, OP5, et CV20 à CV22 favorables | `--reel` ajouté au déclencheur | [§6](#6-le-mode--dry_run-par-défaut---reel-à-la-main) |

**Pourquoi le 2026-10-09.** La liste blanche impose des délais de 48 h (S11) :
une adresse ajoutée par erreur ne se corrige pas dans la journée, une clé mal
créée se révoque et se recrée. OP2 doit avoir mesuré avant OP4, et OP4 avant le
virement du 27 : le 9 laisse deux semaines à ce qui déborde.

## 1. Le principe, avant les clics

C'est la première clé du projet **capable de faire bouger de l'argent**
(`can_transfer`). Ce qui la borne, dans l'ordre :

1. **Le portefeuille.** Elle est scopée sur *Primary*, et seul *Primary* peut
   envoyer ou retirer (S9). Ce qu'elle atteint au pire, c'est ce que *Primary*
   porte : l'opérateur n'y laisse que ce que le convoyeur doit voir passer (D3,
   U4).
2. **La liste blanche d'adresses, activée et vide** (D3). Elle limite les envois
   aux adresses du carnet ; vide, elle ne devrait en permettre aucun. *Devrait* :
   la page est muette sur les envois par API, sur une liste vide et sur les
   retraits EUR (S11). MC2 le mesure (CV21).
3. **Le code** : un passage, un convoyage de 100 EUR au plus (DC8), deux UUID
   comparés exactement (CV2), aucune route v2 (CV4). Il borne le convoyeur, **pas
   une clé fuitée**, qui n'exécute pas ce code.

Ce qui **ne** la borne **pas** :

- **La restriction IP** (S12) : les Jobs Scaleway n'ont pas d'IP de sortie fixe
  (S13). Ne pas en poser : le job serait refusé.
- **Le sens de `transfer`** : décrit tantôt comme « entre vos portefeuilles
  seulement », tantôt comme « envoyer et recevoir, sur et hors plateforme »
  (S10). On prend la lecture la plus défavorable, comme
  [cle-coinbase.md](cle-coinbase.md) l'a toujours fait.
- **Le scoping en v2** : la clé d'Ubac lit le compte entier par `/v2/accounts`
  (constat du 2026-09-11, [cle-coinbase.md](cle-coinbase.md#le-scoping-ne-couvre-pas-les-endpoints-v2)).
  Celle du convoyeur aussi, très probablement.

## 2. OP1 — La liste blanche, puis la clé

**Dans cet ordre** : la clé ne doit jamais exister sans la liste blanche. Tout se
fait sur le web, depuis le compte de l'opérateur. Les chemins de l'interface
changent ; ce qui compte est le résultat, vérifié en 2.4.

### 2.1 Activer la liste blanche, et la laisser vide

```
coinbase.com  →  Settings  →  Security  →  Allowlisting (address book)  →  activer
```

- Le **carnet d'adresses reste vide**. S'il porte déjà des adresses, les
  retirer : une adresse du carnet est une adresse où la clé peut peut-être
  envoyer.
- La liste blanche vaut **pour tout le compte**, application comprise : un envoi
  de crypto que l'opérateur ferait à la main vers une adresse nouvelle exige de
  l'ajouter, puis d'attendre **48 h** (S11).
- La **désactiver prend aussi 48 h** (S11). C'est ce qui la rend utile : une clé
  ou une session volée ne l'ouvre pas dans la soirée.
- MC2 enverra 1 USDC vers une adresse **de l'opérateur**, **hors carnet** :
  ne pas l'y ajouter.

### 2.2 Créer la clé sur *Primary*

Dans le **CDP Portal**, section API Keys, comme à l'étape 2 de
[cle-coinbase.md](cle-coinbase.md#2-créer-la-clé-api-scopée-dessus) :

- un nom explicite : `ubac-convoyeur-primary` ;
- réglages avancés, *Coinbase App & Advanced Trade* : **portefeuille
  *Primary***. C'est le défaut de l'interface ; le piège s'inverse : **ne pas**
  choisir `ubac-agent`, que le convoyeur ne fait qu'alimenter ;
- permissions : **`view` + `trade` + `transfer`** (D1). `move_funds` exige
  `transfer` (S7) ; sans elle, le convoyeur refuse de démarrer (CV1, DC2) ;
- signature **Ed25519**, comme la clé d'Ubac
  ([cle-coinbase.md](cle-coinbase.md#deux-pièges-dimplémentation-constatés-à-la-vérification)) ;
- **aucune restriction IP** (§1).

> **C'est ici qu'on se trompe de clé.** La case `transfer` se coche pour **cette**
> clé, sur *Primary*, et pour aucune autre. **La clé d'Ubac garde
> `can_transfer=false`**, sur `ubac-agent`, en phase 1 comme après (D2) : ne
> pas modifier ses permissions, ne pas lui ajouter `transfer` « pour essayer ».
> Si l'interface ouvre une clé existante plutôt qu'un formulaire vierge,
> s'arrêter. Une clé d'Ubac qui transfère serait de toute façon refusée au run
> de 07:00 par `permissionsFrom` (K1) ; le run ne partirait pas.

### 2.3 Ranger la clé hors du dépôt

Coinbase propose le téléchargement d'un JSON à la création ; **le secret n'est
affiché qu'à ce moment-là**. Le ranger tel quel, sans l'ouvrir dans un éditeur
ni le coller nulle part :

```sh
mkdir -p -m 700 ~/.config/ubac-convoyeur
mv ~/Downloads/cdp_api_key.json ~/.config/ubac-convoyeur/cle.json   # nom du fichier téléchargé
chmod 600 ~/.config/ubac-convoyeur/cle.json
ls -l ~/.config/ubac-convoyeur/cle.json    # attendu : -rw-------
```

- **Hors du dépôt**, et hors des dossiers synchronisés (*Bureau* et *Documents*
  le sont souvent par iCloud). `~/.config` ne l'est pas.
- **Jamais** dans le `.env` du poste : c'est celui d'Ubac, et Ubac ne lit jamais
  la clé du convoyeur (D2, CV3).
- Le téléchargement retiré : vérifier que `~/Downloads` ne garde pas de copie.

### 2.4 Vérifier ce qui a réellement été accordé

Une case cochée n'est pas une preuve ; la permission effective en est une. La
commande lit le fichier **dans le conteneur `dev`**, en lecture seule, appelle
`key_permissions` et n'imprime que cinq champs, jamais la clé ni un jeton :

```sh
docker compose run --rm --no-deps \
  -v "$HOME/.config/ubac-convoyeur/cle.json:/run/cle-convoyeur.json:ro" \
  dev node --input-type=module -e '
import { readFileSync } from "node:fs";
import ccxt from "ccxt";
const cle = JSON.parse(readFileSync("/run/cle-convoyeur.json", "utf8"));
const ex = new ccxt.coinbase({ apiKey: cle.id ?? cle.name, secret: cle.privateKey });
try {
  const r = await ex.v3PrivateGetBrokerageKeyPermissions();
  const { portfolio_uuid, portfolio_type, can_view, can_trade, can_transfer } = r;
  console.log(JSON.stringify({ portfolio_uuid, portfolio_type, can_view, can_trade, can_transfer }));
} catch (e) {
  console.error(`refus : ${e.constructor.name} ${String(e.message).slice(0, 200)}`);
  process.exitCode = 1;
}
'
```

Attendu :

| Champ | Valeur |
|---|---|
| `portfolio_type` | `DEFAULT` : le seul portefeuille de ce type est *Primary* ([cle-coinbase.md](cle-coinbase.md#résultat-du-contrôle-2026-09-11)) |
| `portfolio_uuid` | l'UUID de *Primary* — **pas** celui de `ubac-agent` |
| `can_view`, `can_trade`, `can_transfer` | le booléen `true`, les trois |

Un `refus : AuthenticationError … 401` veut dire que le fichier n'est pas lu
comme il faut (champs `id` / `privateKey` absents, ou clé ECDSA) : **ne pas**
recopier la clé ailleurs pour essayer, recréer une clé Ed25519.

Constaté le 2026-10-01 avec une clé **fabriquée** : le fichier en `600` est lu
dans le conteneur, la requête part signée, l'exchange répond 401, et la sortie
ne porte que la ligne `refus`.

### 2.5 Ce qui se rapporte dans Orca

- la ligne JSON de 2.4, telle quelle : portefeuille, type, `can_*` — **sans la
  clé** ;
- l'état de la liste blanche : activée, carnet vide, date d'activation ;
- `ls -l` du fichier : `-rw-------`, hors dépôt.

L'UUID de *Primary* est celui de `CONVOYEUR_PRIMARY_UUID` (§4). Il va dans Orca
et chez Scaleway, **jamais dans un fichier versionné**.

## 3. Ce que la clé peut faire au pire

Lue sans le code du convoyeur, comme le ferait un voleur :

| Geste | Possible ? | Borné par |
|---|---|---|
| Lire tout le compte | probablement, par la v2 | rien : la confidentialité n'est pas une barrière |
| Acheter ou vendre dans *Primary* | oui (`trade`) | le solde de *Primary* (D3) |
| `move_funds` de *Primary* vers un autre portefeuille du compte | oui (S7) | l'argent reste dans le compte |
| `move_funds` **depuis** un autre portefeuille | **à mesurer** : MC1, CV20 | si oui, toute la fortune du compte est à portée : **pas de mise en réel** |
| Envoyer de la crypto hors de Coinbase | **à mesurer** : MC2, CV21 | la liste blanche vide, si elle couvre l'API (S11) |
| Retirer de l'EUR vers le compte bancaire | **à mesurer** : MC2, CV21 | le compte lié est celui de l'opérateur |

**Le pire, si MC1 et MC2 sont favorables** : ce que *Primary* porte, déplacé
dans le compte ou converti. D'où la règle d'U4 : *Primary* ne porte d'EUR que
pour le convoyeur, qui en convoierait tout autre dépôt par tranches de 100.

**Si MC1 ou MC2 est défavorable**, la clé est révoquée, OP4 n'a pas lieu avec
elle, et la suite est une décision de l'opérateur dans Orca.

**Couper vite** : révoquer la clé dans le CDP Portal. C'est le seul geste qui
arrête aussi une clé fuitée ; retirer le déclencheur n'arrête que le job.

## 4. Les huit variables du convoyeur

**Fixées ici** ; le chargeur `src/convoyeur/env.ts` (Y5) les lit sous ces noms
exacts, et aucune autre. Toutes portent le préfixe `CONVOYEUR_` : aucune ne
partage son nom avec une variable d'Ubac, et la sonde de CV3 compare les deux
listes.

| Variable | Valeur | Forme exigée au démarrage |
|---|---|---|
| `CONVOYEUR_DATABASE_URL` | chaîne *pooled* Neon **du rôle `ubac_convoyeur`** (§5) | URL `postgres://` ou `postgresql://` |
| `CONVOYEUR_COINBASE_API_KEY` | l'identifiant de la clé (`id` du JSON) | non vide |
| `CONVOYEUR_COINBASE_API_SECRET` | le secret (`privateKey` du JSON) | non vide |
| `CONVOYEUR_PRIMARY_UUID` | l'UUID de *Primary*, lu en 2.4 | UUID en minuscules, tel que `key_permissions` le rend |
| `CONVOYEUR_DESTINATION_UUID` | l'UUID de `ubac-agent` : **la même valeur** que `COINBASE_PORTFOLIO_UUID` d'Ubac | UUID en minuscules |
| `CONVOYEUR_NTFY_URL` | même valeur que `NTFY_URL` | URL `https://` |
| `CONVOYEUR_NTFY_TOPIC` | même valeur que `NTFY_TOPIC` | `[A-Za-z0-9_-]`, 64 au plus |
| `CONVOYEUR_NTFY_TOKEN` | même valeur que `NTFY_TOKEN` | un jeton porteur, **ou** la sentinelle `CANAL-PUBLIC-SANS-JETON` ([deploiement.md](deploiement.md#ntfy_token--le-canal-ouvert-se-déclare)) |

- **Chez Scaleway, seulement**, en variables **secrètes** de la définition
  `ubac-convoyeur` (OP4), créée à **140 mVCPU, 256 Mio, délai 600 s, aucune
  tentative** : les valeurs que `deploy-convoyeur` exige à chaque tag
  ([integration-continue.md](integration-continue.md) §8). Ni dans le `.env` du poste, ni dans `.env.example`,
  ni dans les secrets GitHub, ni dans la définition d'Ubac — et aucune variable
  d'Ubac dans celle du convoyeur (CV3).
- Les valeurs ntfy sont **posées deux fois**, sous deux noms : même canal,
  préfixe « convoyeur » dans le titre (CV17). Changer le jeton d'Ubac, c'est
  changer les deux.
- **Ni Brevo, ni healthcheck** : le convoyeur n'envoie aucun email (CV17), et la
  spec ne prévoit pas de surveillance d'absence (§9 ci-dessous).
- Comme pour Ubac, une variable manquante ou mal formée arrête le démarrage en
  **nommant la variable, jamais sa valeur**.

## 5. OP3 — Le rôle Neon et son mot de passe

Le convoyeur écrit sous `ubac_convoyeur` : `INSERT` sur `cash_flows`, `SELECT`
et `INSERT` sur `convoyeur_journal`, rien d'autre (Q9, CV19). Le rôle est créé
**par SQL**, depuis le poste : créé depuis la console Neon, il hériterait de
`neon_superuser`. Le script et sa commande sont dans
[base-de-donnees.md](base-de-donnees.md#le-rôle-du-convoyeur--rejouer-le-script-après-chaque-push).

Dans l'ordre, depuis le poste, `DATABASE_URL` étant **la chaîne d'Ubac**
(propriétaire des tables) dans l'environnement du terminal :

1. compter `cash_flows` et noter les origines, avant ;
2. `npm run db:push` sur Neon, **avec TTY**, le SQL sous les yeux — **pas**
   `make db-push`, qui vise la base locale
   ([deploiement.md](deploiement.md#2-les-migrations-avant-le-déploiement-et-depuis-le-poste)) ;
3. relever ce que `PUBLIC` tient (`aclexplode`), puis rejouer
   `scripts/role-convoyeur.sql` par la commande de la même section ;
4. poser le mot de passe, **à la main**, sans qu'il passe par l'historique du
   shell ni par le dépôt :

   ```sh
   openssl rand -hex 32        # hexadécimal : rien à échapper dans une URL
   docker compose run --rm --no-deps -e DATABASE_URL db sh -c 'psql "$DATABASE_URL"'
   # puis, dans psql :
   \password ubac_convoyeur
   ```

5. composer `CONVOYEUR_DATABASE_URL` sur la chaîne *pooled* : utilisateur
   `ubac_convoyeur`, ce mot de passe, même hôte et même base ; la poser chez
   Scaleway et nulle part ailleurs ;
6. constater les droits listés par OP3 dans le
   [plan](plans/ubac-convoyeur.md#étapes-de-lopérateur) et les rapporter dans
   Orca, sans le mot de passe.

**Après tout `push` qui touche `cash_flows` ou le journal**, rejouer le script :
un `push` qui recrée une table efface ses droits, et le schéma ne les connaît
pas. Le mot de passe, lui, survit au script.

## 6. Le mode : `DRY_RUN` par défaut, `--reel` à la main

Décision **DP5 = 2**. Le point d'entrée est
`node dist/convoyeur/main.js --at=<instant> --git-sha=<sha> [--reel]` (Y5).
Dans l'image `ubac-convoyeur` (Y6), `scripts/entrypoint-convoyeur.sh` fabrique
`--at` et `--git-sha`, et ajoute après eux les arguments du déclencheur.

- **Sans `--reel`, c'est un `DRY_RUN`** : l'exchange est lu, l'ordre, le
  `move_funds` et l'écriture en base passent par des ports inertes qui
  journalisent ce qu'ils auraient fait (CV16). À l'inverse d'Ubac, **l'oubli
  d'un argument ne met jamais en réel**.
- **Passer au réel** (OP6) : ajouter `--reel` aux arguments du **déclencheur**
  `convoyeur` dans la console Scaleway. Aucune PR. Le message Orca cite les
  rapports MC1 à MC3, OP5 et les fusions de S13 et Y8.
- **Revenir au `DRY_RUN`** : retirer `--reel`. C'est le geste de prudence à
  tout moment, sans révoquer la clé.
- Un argument inconnu (`--real`, `--reel=oui`) **refuse le démarrage** plutôt
  que de retomber en silence sur le `DRY_RUN`.

**Le mode est dit partout**, parce que rien ne l'empêche dans `git` :

| Où | Ce qu'on lit |
|---|---|
| première ligne du journal de chaque passage | `mode=DRY_RUN` ou `mode=REEL` |
| titre de chaque notification | `convoyeur DRY_RUN — …` ou `convoyeur — …` (DP4 = 1) |
| chaque déploiement (Y7b) | le mode lu sur le déclencheur, au résumé du run ; la relecture constate qu'il n'a pas changé pendant le déploiement |

**Ce que le `DRY_RUN` journalise** (`src/convoyeur/inertes.ts`) : la clé, les
soldes et le journal sont lus pour de vrai ; l'ordre (`coinbase inerte : ordre
retenu, non placé`), le `move_funds` (`move_funds retenu, non appelé`) et
chaque ligne de base (`base inerte : … non écrite`) sont retenus. Aucun prix
n'étant lu, l'ordre retenu est dit rempli de **100 USDC fictifs, à parité et
sans frais** : la notification d'un `DRY_RUN` porte ces montants, le réel
transférera le `filled_size` de son ordre.

**Le code de sortie** : 0 pour un passage sans convoyage, ou un convoyage
complet notifié ; 1 pour un refus, une panne (notification `urgent`), une
notification perdue, ou un démarrage refusé (argument, variable). Le script
`npm run convoyeur -- --git-sha=<sha>` fabrique `--at`, comme `daily` ; il
demande les huit variables, qui ne sont posées que chez Scaleway (§4).

**Un lancement à la main hors déclencheur** (*Run job*, `scw jobs definition
start`) ne porte pas les arguments du déclencheur : sauf à les lui redonner,
c'est un `DRY_RUN`. Lire la première ligne du journal avant de conclure quoi que
ce soit d'un passage.

## 7. Octobre : le `DRY_RUN` voit l'EUR, puis le geste manuel

Q10 = 2, U6, critère **CV23**. Le virement d'octobre est vu par le `DRY_RUN`
**et** convoyé à la main une dernière fois. Les deux se contrarient si
l'opérateur agit trop tôt : un passage qui ne voit plus d'EUR ne prouve rien.

1. **Ne rien toucher** à l'arrivée du virement (~2026-10-27).
2. **Attendre la notification « convoyeur DRY_RUN »** du passage de 19:00
   (18:00 UTC : l'heure d'hiver commence le 25). Sans EUR `available`, le
   passage ne dit rien (CV5) : attendre le soir suivant.
3. **Puis**, avant 07:00 le lendemain :
   - convertir **dans *Primary***, jamais dans `ubac-agent` (DC1) : achat
     USDC-EUR de 100 EUR ;
   - transférer **tout** l'USDC acheté de *Primary* vers `ubac-agent` : un USDC
     laissé dans *Primary* serait lu le soir suivant comme étranger (CV10),
     avec une alerte `urgent` ;
   - saisir la ligne `cash_flows` comme aujourd'hui (origine `OPERATEUR` par
     défaut).
4. **Rapporter dans Orca** (CV23) : les lignes du journal du passage (l'ordre
   et le transfert qu'il aurait faits), le constat que rien n'a bougé avant le
   geste, et le rapport d'Ubac du lendemain.

## 8. Le passage, et le geste de reprise après une alerte `urgent`

### Le passage (`src/convoyeur/passage.ts`, Y4b)

Un passage lit la clé (CV1), puis le journal, puis les soldes de *Primary*, et
fait **une chose au plus** : finir le convoyage que le journal laisse ouvert,
ou en commencer un (DC6, DC8). Chaque étape d'annonce est écrite **avant**
l'appel : `ACHAT_DEMANDE` avant l'ordre, `TRANSFERT_DEMANDE` avant
`move_funds`. Entre deux étapes, la table de reprise du
[plan](plans/ubac-convoyeur.md#3-la-reprise-se-lit-sur-lexchange-et-linstant-dun-transfert-repris-aussi)
relit l'exchange.

- **Les tentatives** : une lecture et l'achat font quatre essais au plus, à 3 s
  d'intervalle ; l'achat, sous le même `client_order_id`, ne crée jamais un
  second ordre (S5). L'ordre se relit quatre fois avant d'être dit « non
  rempli ».
- **`move_funds` part une fois par passage au plus**, levé ou non : ensuite le
  passage relit le solde de *Primary* (0 : fait ; `filled_size` : non
  constaté) et ne rappelle jamais. S'il le faut, c'est le passage suivant qui
  transfère, l'USDC étant encore là (DC3).
- **L'instant de l'apport** (DC5) est celui de la `TRANSFERT_DEMANDE` du
  passage qui a appelé `move_funds`. Un transfert **refait** par un passage
  ultérieur prend l'instant de sa propre demande, pas celui de la première,
  restée sans effet : l'apport tombe dans la fenêtre où l'USDC arrive. Un
  transfert trouvé **fait** à la reprise prend l'instant de la demande écrite
  au journal.
- **Où il s'arrête** : une erreur qui survit à ses tentatives, ou un ordre
  encore ouvert, arrête le passage sur l'étape écrite, `urgent`, et le passage
  suivant reprend seul. Un refus d'achat de l'exchange (`success: false`) en
  fait partie : il se retente sous le même identifiant, puis s'arrête à
  `ACHAT_DEMANDE`. **`EN_PANNE`** est réservé à ce que la table dit incohérent
  (USDC relu ni nul ni `filled_size`, USDC parti sans demande) et à un ordre
  clos sans être rempli ; rien ne reprend alors sans l'opérateur.
- **Le délai du job** : au pire 25 appels à l'exchange au délai ccxt de 10 s,
  sept séries d'écriture en base et 117 s de pauses, environ 6 min. La
  définition Scaleway (OP4) a un délai de **10 min** et **aucune tentative** :
  un passage tué se reprend au suivant, jamais par un relancement automatique.

### Après une alerte `urgent`

En `DRY_RUN`, rien n'est écrit : seuls un refus (clé, USDC étranger) ou une
panne de lecture peuvent être `urgent`. Ce qui suit vaut **en réel**.

La notification dit l'étape atteinte, ce qui manque, et **ce que le run de
07:00 lira** (CV13). Le convoyeur reprend seul au passage suivant, d'après son
journal et les soldes relus (DC3, DC6) ; le geste de l'opérateur est surtout de
**ne pas le contrarier**.

**Jamais**, tant qu'un convoyage est ouvert :

- **déplacer de l'USDC à la main** entre *Primary* et `ubac-agent` : la reprise
  relit *Primary* pour savoir ce qui reste à transférer, et un solde qu'elle
  n'attend pas la met en panne ;
- **saisir à la main la ligne `cash_flows`** d'un transfert du convoyeur : il
  l'écrira lui-même, sous sa clé naturelle, et l'apport serait compté deux
  fois ;
- **modifier ou supprimer** une ligne du journal : il est en ajout seul.

| Étape dite | Ce que lira le run de 07:00 | Geste |
|---|---|---|
| `ACHAT_DEMANDE`, `ACHETE` | rien de ce convoyage : l'invariant tient | aucun ; le passage suivant relit l'ordre ou transfère |
| `TRANSFERT_DEMANDE`, `TRANSFERE` | l'USDC sans sa ligne : une fausse performance, définitive (K3) | **relancer le passage avant 07:00**, en réel (§6), puis lire `ENREGISTRE` dans sa notification |
| `EN_PANNE`, ou refus « USDC étranger » | à constater | relever *Primary* (EUR, USDC), `ubac-agent` (USDC) et les dernières lignes de `cash_flows` ; rapporter dans Orca ; **rien ne reprend seul** |

### Clore un convoyage `EN_PANNE`

`EN_PANNE` est redit, `urgent`, à chaque passage, et aucun convoyage ne
commence tant qu'il n'est pas clos. La clôture est **une ligne `ENREGISTRE`
ajoutée** au convoyage en panne : le journal reste en ajout seul, et
`ENREGISTRE` l'emporte sur `EN_PANNE` à la relecture. Dans l'ordre :

1. **rétablir DC6** à la main, d'après les relevés : ou bien l'USDC acheté est
   dans `ubac-agent` **et** a sa ligne `cash_flows` (saisie comme aujourd'hui,
   à l'instant du transfert, **avant** le run de 07:00), ou bien ni l'un ni
   l'autre ;
2. **laisser *Primary* sans USDC** : le passage suivant lirait un reste comme
   étranger (CV10) ;
3. **clore**, avec la chaîne d'Ubac et le `psql` du §5, `<jour>` étant le
   convoyage dit par la notification :

   ```sql
   INSERT INTO convoyeur_journal (convoyage, day, step, occurred_at, reason)
   SELECT convoyage, day, 'ENREGISTRE', now(), 'clos par l''operateur : <constat>'
   FROM convoyeur_journal WHERE day = '<jour>' AND step = 'EN_PANNE';
   ```

4. **rapporter dans Orca** les relevés et le constat. Le passage suivant
   reprend le cours normal : convoyage du jour si l'EUR est là.

Une alerte reçue après 07:00, ou un passage qui n'a pas tourné, laisse le run
lire un apport sans sa ligne : c'est la panne muette (U9), visible, pas
réparable.

## 9. Ce que ce document ne garantit pas

- **Les chemins de l'interface Coinbase** changent ; ils sont donnés pour
  orienter, le contrôle est 2.4.
- **La forme du JSON téléchargé** (`id`, `privateKey`) est celle des clés
  Ed25519 constatée pour Ubac ; une autre forme fait échouer 2.4 sans rien
  divulguer.
- **La portée de `transfer` et de la liste blanche** reste une hypothèse
  jusqu'à MC1 et MC2 (U1, H5).
- **Les arguments d'un déclencheur Scaleway** : leur passage jusqu'au point
  d'entrée est l'affaire d'Y6 et d'Y7b ; OP4 le constate par la première ligne
  du journal.
- **Un convoyeur qui ne tourne pas ne le dit à personne** : seule l'absence de
  notification le trahit, et l'EUR attend dans *Primary*.

## Sources

| # | Fait | Source |
|---|---|---|
| S7 | `move_funds` exige `transfer` ; aucune clé d'idempotence | [move-portfolios-funds](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/portfolios/move-portfolios-funds) |
| S8 | transfert entre portefeuilles instantané et gratuit | [guide portfolios](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/portfolios), [multiple-portfolios](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/multiple-portfolios) |
| S9 | seul *Primary* envoie ou retire | [multiple-portfolios](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/multiple-portfolios) |
| S10 | `transfer` décrit de deux façons incompatibles | [coinbase-mcp](https://docs.cdp.coinbase.com/ai-agents/coinbase-for-agents/coinbase-mcp), [authorization](https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/authorization), [get-api-key-permissions](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/data-api/get-api-key-permissions) |
| S11 | liste blanche : 48 h pour ajouter, 48 h pour désactiver ; muette sur l'API, la liste vide et l'EUR | [address-book-allowlist](https://help.coinbase.com/en/coinbase/managing-my-account/other/address-book-allowlist) |
| S12 | une clé CDP accepte une liste blanche d'IP | [security-best-practices](https://docs.cdp.coinbase.com/get-started/authentication/security-best-practices) |
| S13 | pas d'IP de sortie fixe pour les Jobs Scaleway | [jobs FAQ](https://www.scaleway.com/en/docs/serverless-jobs/faq/), [jobs-limitations](https://www.scaleway.com/en/docs/serverless-jobs/reference-content/jobs-limitations/) |

Vérifiées le 2026-09-28 par le cadrage ([spec](specs/ubac-convoyeur.md#ce-que-dit-la-documentation-officielle-vérifiée-le-2026-09-28)).
