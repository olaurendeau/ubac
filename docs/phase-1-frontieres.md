# Frontières de la phase 1

Lot Q1a. Ce document dit exactement ce que les garde-fous structurels de la
phase 1 garantissent, et ce qu'ils ne garantissent pas.

Le lot Q1b y ajoute la configuration validée : la divergence `MIN_CASH` 22 %
contre 15 % et la frontière de lecture de l'environnement (sections 3 et 4).

Le lot S4 de la phase 3 réécrit le §1 : la règle de noms est retirée (B4), et
la section dit ce que le dépôt perd et ce qui la remplace.

Références : `docs/specs/ubac-rebalance.md` §2, §3, §6 et §7 ;
`docs/plans/ubac-phase-1.md`, lot Q1.

---

## 1. Le garde-fou C32, converti, puis retiré

### Ce qu'il était

La phase 0 tenait la garantie « aucun ordre ne peut partir » par l'absence des
répertoires :

```ts
describe('C32 — aucun adapter ni job en phase 0', () => {
  it.each(['src/adapters', 'src/jobs'])('%s n’existe pas', …)
});
```

C'était solide et bon marché tant que la phase 0 durait. Ça tombe à la première
ligne de la phase 1.

### Ce qu'il est devenu en phase 1

Une règle ESLint `no-restricted-syntax` sur `src/adapters/**` et `src/jobs/**` :
aucun nom qui dénote un placement, une annulation ou un retrait — onze verbes
(`create`, `place`, `submit`, `send`, `post`, `edit`, `amend`, `modify`,
`replace`, `cancel`, `close`) suivis de `Order`/`order(s)`, et tout nom
contenant `withdraw` ou `transfer` —, quelle que soit sa position syntaxique.
`linterOptions.noInlineConfig` empêchait de la désarmer depuis le fichier
surveillé. Elle ne prouvait pas l'absence d'exécution : elle laissait passer la
répartition dynamique, **un client HTTP générique**, la réflexion, une
dépendance tierce, et tout ce qui vivait hors de ces deux globs.

### Son retrait (B4, lot S4 de la phase 3)

La règle est retirée d'`eslint.config.js`, avec ses deux fixtures
(`bad-order-write`, `bad-order-write-disabled`) et le bloc « C32 (phase 1) » de
`test/structure.test.ts`, **le même jour** : un garde-fou désarmé qui reste vert
est pire que pas de garde-fou (E9). Une règle qui interdit de **nommer** un
placement ne cohabite pas avec une phase dont l'objet est d'en placer.

**Un constat que le cadrage n'avait pas fait.** Le sélecteur est **ancré** sur
les onze verbes, et `v3PrivatePostBrokerageOrders` — la méthode ccxt qui place
réellement un ordre — ne commence par aucun d'eux : **la règle n'aurait pas
attrapé l'appel réel**. Ce qu'elle interdisait, c'était de nommer honnêtement le
port, `placeOrder`. Cette section listait déjà « un client HTTP générique » parmi
ce qu'elle ne garantit pas, sans en tirer la conséquence : **la règle rendait le
contournement plus lisible que le chemin droit.** C'est l'argument le plus fort
en faveur de son retrait.

### Ce que le dépôt perd

La propriété : *aucun module de `src/adapters/**` et `src/jobs/**` ne prononce
un verbe d'écriture d'ordre, ou il rougit*. Elle attrapait l'erreur qui compte —
un placement écrit **ailleurs** que dans le module prévu — et rien ne la tient
plus sous cette forme : un nom d'écriture peut désormais apparaître en silence
dans n'importe quel fichier de ces deux répertoires.

Deux conséquences à ne pas laisser deviner :

- **`noInlineConfig` ne part pas avec la règle.** Le bloc de configuration qui
  la portait reste, réduit à cette option : le supprimer entier aurait rendu
  `eslint-disable` de nouveau utilisable dans ces deux répertoires pour toutes
  les règles, frontière « personne n'importe `jobs/` » comprise.
  `test/structure.test.ts` le tient sur les deux globs.
- **Le mot de la permission de sortie redevient écrivable** dans
  `src/adapters/`. `permissionsFrom` refuse toute permission inattendue qui
  n'est pas le booléen `false`, sans la nommer : **c'est désormais le seul
  contrôle sur ce point**, et il laisse passer une réponse où le champ a disparu
  — S7 doit en exiger la présence.

### Ce qui la remplace : une énumération positive

1. **La surface d'écriture est énumérée (E10).** `WRITE_ROUTES` —
   `create_order`, `cancel_orders` — et `EXECUTION_METHODS` — `placeOrder`,
   `cancelOrders` — sont lisibles à l'exécution, et
   `test/adapters/coinbase.test.ts` les écrit en toutes lettres : ajouter une
   route ou une méthode fait rougir la suite, et `tsc` rougit si le type et sa
   liste divergent. Le verbe `write` vit sur `CoinbaseWriteTransport`,
   distinct du transport du lecteur : le lecteur ne sait toujours rien écrire.
2. **Un seul module les appelle (E11).** A23 de `test/jobs/purete.test.ts`
   réserve l'appel des méthodes du port et le `kind` d'une route d'écriture à
   `src/jobs/execute.ts`, qui **doit** y figurer — un garde-fou qui ne désigne
   personne est vide. `execute.ts` n'a pas d'appelant à la fin de S4 : le lot
   livre la capacité, pas l'usage. **La liste reste à un module** : la sortie
   propre (S11) et l'annulation des ordres anciens (S8, T4) passent *par*
   `execute.ts`, qui applique des intentions sans rien valider.
3. **La clé, à chaque run (E6 à E8).** Les permissions effectives sont lues,
   journalisées et confrontées au portefeuille attendu ; et `can_trade` est
   une **condition de construction** de l'exécuteur (E7) : sans elle,
   `openCoinbaseExecution` lève, et il n'existe aucun paramètre `dryRun`,
   `force` ni `bypass` pour le faire exister autrement.

### Ce que cela ne garantit PAS

**La surface d'écriture est énumérée, pas prouvée.** E10 et E11 disent quelles
routes existent et qui les appelle ; ils ne disent pas qu'un client HTTP
générique, une répartition dynamique (`port[methode]()`, constatée par L2 de
`purete.test.ts`) ou une dépendance tierce ne peut pas en fabriquer une autre.
C'est la limite du lint retiré, déplacée.

La seule garantie *structurelle* reste celle de la spec §7 : une clé scopée sur
le portefeuille dédié, **sans permission de retrait**, vérifiée contre une
valeur attendue. Le contrôle de noms, puis l'énumération, réduisent la surface
d'erreur ; la clé est ce qui rend le retrait impossible.

---

## 2. Frontières de couche

Deux règles, dans `eslint.config.js`, chacune adossée à une fixture de lint qui
la met en défaut. La troisième, sur les noms d'écriture d'ordre, est retirée
en phase 3 : voir §1.

| Règle | Portée | Fixture |
|---|---|---|
| `core` n'importe ni `adapters/` ni `jobs/` | `src/core/**` | `bad-cross-layer-import` (phase 0, inchangée) |
| Personne n'importe `jobs/` | `src/**` sauf `core/`, `jobs/`, `replay/`, `fixture/` | `bad-jobs-import` |

`jobs/` est le point d'entrée exécutable : le runtime l'appelle, le code ne
l'importe pas. Un adapter qui importe un job inverse la composition et rend un
chemin d'exécution atteignable depuis une couche qui n'est censée que lire.
Un job peut en importer un autre — c'est la seule exception, et elle est testée.

### Limites connues de ces frontières

- **`src/core/**` garde ses règles de la phase 0, à l'octet près.** Elles
  interdisent les imports nus hors liste blanche, mais pas un import *relatif*
  de `../config/env.js`, qui ferait entrer `process.env` dans le noyau. Le
  trou est réel et étroit ; le combler suppose de toucher aux règles de core,
  ce que ce lot n'a pas mandat de faire. À trancher séparément.
- **`src/replay/**` et `src/fixture/**` sont exemptés** de la règle « personne
  n'importe `jobs/` ». Ils sont hors ligne par construction depuis la phase 0 et
  leurs fixtures verrouillent déjà leur comportement ; les couvrir aurait
  changé un test de la phase 0 qui passe. À reprendre si un lot ultérieur y
  touche.
- Toute couche **nouvelle** (`src/notify/`, par exemple) est couverte par
  défaut : la règle liste ses exemptions, elle ne liste pas ses cibles.


---

## 3. `MIN_CASH` : 22 %, pas 15 %

### La divergence

| Source | Valeur |
|---|---|
| `src/core/risk.ts`, `MIN_CASH_PCT` | **0.22** |
| `docs/specs/ubac-rebalance.md` §6 | 15 % |
| `docs/specs/ubac-rebalance.md`, annexe, `risk.minCashPct` | 0.15 |

Les deux valeurs coexistent dans le dépôt depuis la phase 0. Ce n'est pas une
question ouverte : c'est un écart connu, dont la décision **D1** a tranché le
sens.

### Pourquoi 22 % l'emporte

1. **C'est la valeur que le code applique et que les tests couvrent.** Le
   cadrage de la phase 0 a retenu 22 %, `risk.ts` l'applique, et la couche
   risque est couverte à 100 % lignes et branches. Les critères C16 et C17 ont
   été validés contre 22 %.
2. **Descendre à 15 % rendrait la production plus permissive que ce que la
   phase 0 a validé**, et le ferait *sans qu'aucun test n'échoue* : un seuil
   plus bas n'invalide aucun cas de test existant, il en laisse simplement
   passer davantage. Un assouplissement silencieux du risque est exactement ce
   que la couche risque est censée rendre impossible.
3. **La cible de cash est à 30 % et le bord bas de la bande à 24 %.** Avec
   `MIN_CASH` à 22 %, le seuil mord avant que la ligne de cash n'atteigne son
   bord bas : il reste un vrai garde-fou. À 15 %, il ne mordrait qu'après une
   dérive de plus d'un tiers sous la bande, donc à peu près jamais.

### Ce qui n'a pas été fait, et pourquoi

`docs/specs/ubac-rebalance.md` **n'est pas modifiée**. Aligner la spec générale
sur le code est une décision distincte, qui n'a pas été prise. Ce lot documente
la divergence et fait en sorte qu'elle ne puisse plus être résolue par accident
dans le mauvais sens.

### Comment la configuration l'empêche de dériver

`src/config/env.ts` **n'expose aucun réglage des seuils de risque**. Ils sont
lus depuis `src/core/risk.ts` et exposés en lecture, pour le rapport quotidien
et le journal, jamais en écriture.

Toute variable d'environnement préfixée `UBAC_RISK_` fait **échouer le
démarrage**. Sans cela, `UBAC_RISK_MIN_CASH_PCT=0.15` posé en production serait
ignoré en silence : l'opérateur croirait avoir changé le seuil, le système
continuerait à 22 % sans le dire. Échouer est la seule réponse honnête — le
seuil se change dans `risk.ts`, avec ses tests.

La configuration confronte en revanche les **paramètres de stratégie** aux
seuils, et refuse de démarrer sur une combinaison que la couche risque
rejetterait à chaque run :

- une cible BTC ou ETH au-delà de `MAX_EXPOSURE` (50 %) ;
- un cash projeté sous `MIN_CASH` (22 %). Le cash projeté dépend du mode :
  `target` repose la ligne sur la cible, `band_edge` sur le bord franchi, qui
  est plus bas. C'est donc le bord bas qu'on compare au seuil quand ce mode est
  armé.

Sans ces contrôles, une configuration valide prise variable par variable produit
un système qui se fait rejeter tous les jours, en silence, jusqu'à ce que
quelqu'un lise le journal des rejets.

---

## 4. La frontière de lecture de l'environnement

`src/config/env.ts` est le seul point de lecture de l'environnement. Il valide
par Zod, échoue au démarrage en nommant la variable fautive, et **remonte toutes
les variables invalides d'un coup** plutôt qu'une par redémarrage.

**La liste des variables vit dans `.env.example`**, versionné, avec pour chacune
sa forme attendue et son défaut. Elle n'est pas recopiée ici : deux listes de la
même chose finissent par diverger, et c'est le modèle que l'opérateur copie qui
doit rester juste. `.env` est ignoré par git.

Ce qui suit ne décrit donc pas les variables, mais les quatre propriétés de la
frontière elle-même.

### Les secrets ne fuient pas dans les messages

Les six variables secrètes du §10 sont requises et sans défaut : un secret
absent arrête le programme au démarrage, plutôt que de produire un 401 au milieu
d'un run.

**Aucun message d'erreur ne recopie la valeur d'un secret.** Il nomme la
variable et la contrainte, rien de plus : une erreur finit dans un journal, et
`DATABASE_URL` porte un mot de passe. Vérifié par un test.

### Les défauts viennent du noyau, jamais d'un littéral

Les défauts des paramètres métier sont lus dans `DEFAULT_REBALANCE_PARAMS`
(`src/core/strategy/rebalance.ts`), jamais recopiés dans le module de
configuration : deux sources pour la même valeur cible finissent par diverger.
`.env.example` les cite en commentaire, à titre indicatif ; le code ne les lit
pas là.

### Aucun flottant à la frontière

C'est ici que la règle non négociable d'`AGENTS.md` se perd le plus facilement :
`z.coerce.number()` sur `"0.30"` est la façon la plus courte d'écrire exactement
ce que tout le noyau évite depuis la phase 0.

Les paramètres de marché sortent de Zod en `Decimal`. La chaîne est d'abord
validée contre une décimale littérale — `^-?(0|[1-9]\d*)(\.\d+)?$` — avant
d'atteindre le constructeur, parce que `decimal.js` accepte aussi `0x10`,
`Infinity` et `NaN`. Un poids `NaN` est le pire des trois : `Decimal.gt` et
`Decimal.lt` répondent tous les deux `false` dessus, donc aucun seuil ne mord,
sur un chemin qu'aucune couverture ne signale puisque la comparaison est bien
exécutée. Même piège que le total non fini de `portfolio.ts`, même parade.

Les seuls `number` du module sont des comptes de jours : ce sont des entiers de
calendrier, pas des grandeurs de marché, et le noyau les tient déjà en `number`.

### `manual` est refusé

Le §5.4 propose `newCashPolicy: "immediate" | "delay7d" | "manual"`. Le noyau ne
connaît qu'un nombre de jours de carence (`newCashFreezeDays`), choix assumé du
cadrage de la phase 0 : `manual` suppose une intervention humaine, qui n'a pas de
représentation dans un module pur.

La configuration **refuse** `manual` au lieu de la faire glisser sur `delay7d`.
Faire glisser donnerait un système qui investit tout seul à un opérateur qui a
demandé à décider lui-même.
