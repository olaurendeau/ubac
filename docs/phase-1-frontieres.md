# Frontières de la phase 1

Lot Q1a. Ce document dit exactement ce que les garde-fous structurels de la
phase 1 garantissent, et ce qu'ils ne garantissent pas.

Le lot Q1b, qui suit, y ajoute la configuration validée : la divergence
`MIN_CASH` 22 % contre 15 % et la liste des variables d'environnement.

Références : `docs/specs/ubac-rebalance.md` §2, §3, §6 et §7 ;
`docs/plans/ubac-phase-1.md`, lot Q1.

---

## 1. Le garde-fou C32, converti

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

### Ce qu'il est devenu

Les deux répertoires peuvent exister. La garantie se déplace de l'arborescence
vers les **appels** : dans `src/adapters/**` et `src/jobs/**`, aucun nom qui
dénote un placement, une annulation ou un retrait n'est écrit.

Le mécanisme est une règle ESLint `no-restricted-syntax`
(`eslint.config.js`), vérifiée de deux façons dans `test/structure.test.ts` :

1. des **fixtures** de `test/lint/fixtures/` prouvent que la règle mord, et
   qu'elle ne mord pas sur un adapter de lecture légitime ;
2. un lint de **l'arbre réel** (`src/adapters/**/*.ts`, `src/jobs/**/*.ts`)
   branche la règle sur le code livré. Les deux globs sont vides aujourd'hui et
   deviennent un verrou au premier fichier, sans qu'aucun lot ultérieur ait à y
   penser.

C'est un contrôle de lint et non une recherche de chaînes : il travaille sur
l'arbre syntaxique, distingue un identifiant d'un commentaire, et ne peut pas
être satisfait en renommant une variable de commentaire.

### Ce qu'il attrape

Les noms sont pris **quelle que soit leur position syntaxique** — appel,
déclaration, propriété lue sans être appelée, clé d'objet, spécificateur
d'import, chaîne de caractères. Un sélecteur posé sur le seul `CallExpression`
serait contourné par `const f = client.createOrder;` suivi de `f()`.

| Forme | Exemple |
|---|---|
| Appel de méthode | `client.createOrder(…)` |
| Référence sans appel | `const f = client.cancelOrder` |
| Accès calculé par chaîne | `client['createLimitBuyOrder'](…)` |
| snake_case natif Coinbase | `client.cancel_all_orders(…)` |
| Retrait et transfert | `client.withdraw(…)`, `transferFunds(…)` |
| Import nommé | `import { placeOrder } from …` |
| Déclaration | `export function submitOrder() {}` |

Le motif couvre les verbes `create`, `place`, `submit`, `send`, `post`, `edit`,
`amend`, `modify`, `replace`, `cancel`, `close` suivis de `Order`/`order(s)`, en
camelCase comme en snake_case, ainsi que tout nom contenant `withdraw` ou
`transfer`.

`// eslint-disable-next-line` ne le désarme pas : `linterOptions.noInlineConfig`
est posé sur ces deux globs. Un garde-fou qu'on éteint depuis le fichier qu'il
surveille n'en est pas un — vérifié par une fixture dédiée.

### Ce qu'il ne garantit PAS

**Ce n'est pas une preuve d'absence d'exécution.** C'est un contrôle de noms,
et un contrôle de noms se contourne. En clair, il laisse passer :

- **la répartition dynamique** : `client[methode]()` où `methode` vient de la
  configuration, d'un `switch`, d'une table construite à l'exécution ;
- **un client HTTP générique** : `http.post('/api/v3/brokerage/orders', …)` ne
  contient aucun des noms surveillés ;
- **la réflexion** : `Reflect.get`, `Object.entries(client)`, `eval` ;
- **une dépendance transitive** : une bibliothèque tierce appelée par un nom
  neutre et qui place l'ordre elle-même ;
- **tout ce qui vit hors de `src/adapters/**` et `src/jobs/**`** — la règle est
  restreinte à ces deux globs, parce que l'appliquer au dépôt entier casserait
  le rejeu, qui manipule légitimement des ordres simulés.

La seule garantie *structurelle* que rien ne part reste celle de la spec §7 :
une clé API scopée sur un portefeuille dédié, **sans permission de retrait**, et
en phase 1 sans permission de trade (décision D4, non encore prise à la date de
ce lot). Le lint réduit la surface d'erreur ; la clé est ce qui rend l'erreur
impossible.

C'est le même statut que le test de contrat de `risk.ts` : utile, tenu, et
explicitement pas une démonstration.

---

## 2. Frontières de couche

Trois règles, dans `eslint.config.js`, chacune adossée à une fixture de lint qui
la met en défaut.

| Règle | Portée | Fixture |
|---|---|---|
| `core` n'importe ni `adapters/` ni `jobs/` | `src/core/**` | `bad-cross-layer-import` (phase 0, inchangée) |
| Personne n'importe `jobs/` | `src/**` sauf `core/`, `jobs/`, `replay/`, `fixture/` | `bad-jobs-import` |
| Aucun nom d'écriture d'ordre | `src/adapters/**`, `src/jobs/**` | `bad-order-write`, `bad-order-write-disabled` |

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

