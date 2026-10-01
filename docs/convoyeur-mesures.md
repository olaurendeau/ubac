# Les mesures MC1 à MC3 de la clé du convoyeur

La mise en réel du convoyeur est conditionnée à trois constats (spec
`docs/specs/ubac-convoyeur.md`, CV20 à CV22) qu'aucune lecture de la
documentation Coinbase ne donne : ce que la clé `transfer` scopée sur *Primary*
peut faire **ailleurs** que sur *Primary*. `scripts/mesures-convoyeur.ts` les
mesure. Il est commité pour être relu (DP2 = 1) : un outil qui tente d'envoyer de
l'argent ne doit pas être un script jetable.

**Il est lancé par l'opérateur, sur son poste, jamais par un agent ni par la
chaîne** : il lit la clé du convoyeur, qu'aucun agent ne lit.

## Ce que le script est, et n'est pas

- **Hors de `src/`, donc hors de toute image.** `tsconfig.build.json` ne compile
  que `src/`, et `Dockerfile.prod` ne copie de `scripts/` que le point d'entrée
  du job ; un test le vérifie (`test/scripts/mesures-convoyeur.test.ts`).
- **La seule place du dépôt où la v2 d'envoi et de retrait est écrite.** CV4 ne
  vise que `src/convoyeur/` (bloc convoyeur d'`eslint.config.js`) : le
  convoyeur ne peut pas écrire la v2, et MC2 doit la tenter pour constater
  qu'elle est refusée. Ces deux routes vivent ici, dans un transport à part,
  et nulle part ailleurs.
- **Le reste est l'adapter du convoyeur, tel quel** (`src/convoyeur/coinbase.ts`) :
  la clé vérifiée (CV1 : *Primary*, `DEFAULT`, `view` + `trade` + `transfer`)
  et les soldes de *Primary* avant et après chaque mesure ; `moveFunds` pour
  MC3, c'est-à-dire le chemin réel du convoyeur. MC1 passe par son transport,
  parce que le port refuse avant tout appel la source que MC1 doit justement
  essayer (CV2).

Ce que le script garantit, et que ses tests tiennent :

1. **une requête d'écriture par mesure**, jamais deux : ni rejeu, ni boucle sur
   un échec ;
2. **aucune sans confirmation** : l'opérateur tape le nom de la mesure ;
3. **aucune si la source lisible ne porte pas le montant** : un refus pour solde
   insuffisant ne prouverait rien ;
4. **ni la clé, ni un jeton, ni un en-tête** dans la sortie, même si l'exchange
   les recopiait dans un message d'erreur ;
5. **rien à moins de 30 minutes du run d'Ubac** (07:00 Europe/Paris), pas même
   une lecture ;
6. **une clé rangée dans le dépôt est refusée**.

## Avant de mesurer

- **OP1 fait** : la clé du convoyeur existe sur *Primary*, `view` + `trade` +
  `transfer`, et la liste blanche d'adresses est **activée et vide**.
- **La clé dans un fichier hors dépôt**, tel que la console CDP le donne
  (`name` ou `id`, et `privateKey`), `chmod 600`. Par exemple
  `~/.config/ubac/cle-convoyeur.json`.
- **Les deux UUID** : *Primary* et `ubac-agent`.
- **Les montants à la source**, 1 par mesure : 1 USDC dans *Primary* pour
  `mc2-crypto` et `mc3`, 1 EUR dans *Primary* pour `mc2-eur`, **et au moins
  1 USDC disponible dans `ubac-agent` pour `mc1`**. La clé ne lit pas
  `ubac-agent` : ce dernier solde se vérifie dans l'application, et le script le
  rappelle avant de demander la confirmation.
- **Le moment** : entre deux runs d'Ubac, **MC1 et MC3 entre les deux mêmes**,
  et avant OP4 (DP3 = 1 : si MC1 ou MC2 échoue, cette clé ne doit jamais avoir
  été déployée).

## La commande

`./scripts/dev.sh` ne monte que le dépôt ; la clé, hors dépôt, se monte en
lecture seule par `docker compose run -v` :

```sh
docker compose run --rm --no-deps \
  -v "$HOME/.config/ubac/cle-convoyeur.json:/run/secrets/cle-convoyeur.json:ro" \
  dev npx tsx scripts/mesures-convoyeur.ts <mesure> \
  --cle /run/secrets/cle-convoyeur.json \
  --primary <uuid de Primary> --ubac-agent <uuid d'ubac-agent> [options]
```

| Mesure | Options | Requête unique | Attendu |
|---|---|---|---|
| `moyens` | — | aucune écriture : liste les moyens de paiement (id, type, devise, retrait permis) | donne l'id du compte bancaire pour `mc2-eur` |
| `mc1` | — | `move_funds` 1 USDC de `ubac-agent` vers *Primary* | **refus** (CV20) |
| `mc2-crypto` | `--adresse <votre adresse>` `[--reseau base]` | envoi v2 de 1 USDC depuis *Primary* | **refus** par la liste blanche vide (CV21) |
| `mc2-eur` | `--moyen <id>` | retrait v2 de 1 EUR depuis *Primary* | noté, **quel qu'il soit** (CV21) |
| `mc3` | — | `move_funds` 1 USDC de *Primary* vers `ubac-agent` | **accepté**, et le solde relu le reflète (CV22) |

Ordre conseillé : `moyens`, `mc1`, `mc2-crypto`, `mc2-eur`, `mc3`.

**Le destinataire est toujours l'opérateur** : son adresse, son compte
bancaire. Un envoi qui réussit est une mauvaise nouvelle, pas une perte.

Chaque mesure imprime les soldes de *Primary* avant, l'instant de la requête, le
code HTTP, la réponse ou le refus (classe et message de l'exchange), les soldes
après et l'écart. Le script ne conclut pas à la place de l'opérateur : **un
refus pour un paramètre** (réseau, adresse mal formée) **ne prouve rien pour
CV21** ; le message dit lequel.

## Après : net nul pour `ubac-agent`

- **MC1 refusé (attendu)** : rien n'a bougé. MC3 ajoute alors 1 USDC à
  `ubac-agent` : c'est un **apport**, que l'opérateur saisit dans `cash_flows`
  comme aujourd'hui (`origin` par défaut, `OPERATEUR`), +1 USDC à l'**instant
  imprimé par `mc3`**, avant 07:00. Sinon Ubac le lit comme une performance (K3).
- **MC1 accepté (mauvaise nouvelle)** : `ubac-agent` perd 1 USDC à MC1 et le
  regagne à MC3 ; entre les deux mêmes runs, le net est nul, rien à saisir.
- ***Primary* finit à 0 USDC** : un reste serait lu comme USDC étranger par le
  premier passage du convoyeur (CV10).

## Ce qui se rapporte dans Orca

Des constats, jamais la clé, un en-tête ou un jeton (la sortie est masquée, mais
se relit avant d'être collée) :

- **CV20** : code et message de `mc1`, soldes avant / après ;
- **CV21** : code et message de `mc2-crypto`, et de `mc2-eur` quel qu'il soit ;
- **CV22** : réponse de `mc3` et solde relu ;
- l'instant de chaque mesure, et la ligne `cash_flows` saisie le cas échéant.

**Si `mc1` ou `mc2-crypto` est accepté**, OP4 n'a pas lieu avec cette clé : elle
est révoquée, et la suite revient à l'opérateur par une décision Orca.

## Limites

- **`ubac-agent` n'est pas lu par la clé** : la condition « la source porte le
  montant » de MC1 repose sur l'application, pas sur le script.
- **Le code HTTP est observé, pas rendu par ccxt** : le script l'intercepte au
  passage de chaque réponse. Une panne réseau avant toute réponse l'imprime
  « inconnu ».
- **Une mesure ne se souvient pas de la précédente** : l'ordre MC1 puis MC3, et
  la saisie qui en découle, restent la discipline de l'opérateur.
- **Une mesure vaut pour le jour où elle est faite** : MC1 et MC2 constatent la
  clé et la liste blanche telles qu'elles sont ce jour-là, pas pour toujours.
