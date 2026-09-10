# Plan : ubac-phase-1

Spec de référence : `docs/specs/ubac-rebalance.md`, sections 2, 3, 4, 6 à 11
et 14. Plan établi le 2026-09-10, après clôture de la phase 0.

## Avertissement sur la référence

**La phase 1 n'a pas de spec dédiée.** La phase 0 avait
`docs/specs/ubac-phase-0.md` et ses critères numérotés C1 à C32, qui prévalaient
sur la spec générale. Ici, la référence est la spec générale, organisée en
sections et non en critères d'acceptation numérotés.

Conséquence assumée : la table de couverture ci-dessous rattache des **exigences
de section**, pas des critères numérotés. Les critères de validation de chaque
lot tiennent lieu de critères d'acceptation tant qu'aucun cadrage n'a produit
`docs/specs/ubac-phase-1.md`. C'est une faiblesse de traçabilité par rapport à
la phase 0, à corriger par un cadrage si l'opérateur le décide.

Ce plan n'écrit aucun code et ne modifie aucun critère métier.

## État de départ

Phase 0 close, `main` à `c9c277a`. `make check` passe : 21 fichiers de test,
404 tests. Le noyau est complet et pur :

| Acquis | Contenu |
|---|---|
| `src/core/` | `types`, `portfolio`, `order-id`, `risk`, `config`, `strategy/{rebalance,ladder,dca}`, `benchmark` |
| `src/fixture/` | normalisation des bougies, sans IO |
| `src/replay/` | moteur de rejeu et rapport déterministe |
| Garde-fous | `test/structure.test.ts` + `eslint.config.js` |

Aucune PR ouverte, aucune branche de travail à reprendre. Les branches
`etape/ubac-phase-0-*` restent en place et ne servent plus.

La phase 1 n'écrit **rien** dans `src/core/`. Le noyau est le produit fini de la
phase 0 ; toute modification y est une régression jusqu'à preuve du contraire et
passe par une décision, pas par un ajustement technique.

## Le garde-fou qui doit changer en premier

`test/structure.test.ts` contient :

```
describe('C32 — aucun adapter ni job en phase 0', () => {
  it.each(['src/adapters', 'src/jobs'])('%s n’existe pas', …)
});
```

Il **tombera à la première ligne de la phase 1**. Le supprimer serait perdre
d'un coup la garantie structurelle que rien ne peut passer d'ordre. Il doit être
**converti**, pas retiré : de « ces répertoires n'existent pas » à « ils
existent, et aucun chemin d'exécution ne place d'ordre ». C'est l'objet du lot
Q1, qui précède tout le reste.

Le risque de séquencement est réel : un lot d'adapter livré avant Q1 aurait à
choisir entre casser la suite de tests et désarmer le garde-fou lui-même.

## Périmètre exclu de la phase 1

- **Toute exécution d'ordre.** Aucun `place()`, aucun `cancel()` armé. La
  phase 1 est en observation, c'est sa raison d'être.
- Scaleway, Docker, GitHub Actions, registry, cron hébergé : c'est la phase 2.
  Le job doit tourner à la main depuis le poste, en une commande.
- Export CSV des cessions et formulaire 3916-bis : hors phase 1.
- Le PRU, exclu en phase 0 pour la même raison : sa méthode de calcul n'est pas
  tranchée et il ne sert qu'à l'export fiscal.
- Tout ajustement des bandes selon les données observées : c'est la phase 4.

## Convention de livraison

Une PR par lot, jusqu'à **1 000 lignes ajoutées + supprimées**, code, tests et
documentation compris. Le plafond n'est pas une cible. Migrations générées et
lockfiles sont exclus du compte, avec volume et validation documentés
séparément.

Chaque lot exécute son critère détaillé, `make typecheck` et `make test`. Tout
passe par Docker ; aucun `node` ni `npm` sur le host. Une dépendance est
satisfaite après merge vérifié dans Orca, jamais au seul retour du worker.

**Aucun secret en clair dans le dépôt, à aucune étape.** Les lots qui touchent
à des identifiants livrent un `.env.example` et la validation de leur présence,
jamais leur valeur.

## Décisions préalables

Sept ambiguïtés relevées à la lecture de la spec. Chacune bloque son lot et
demande une décision de l'opérateur avant dispatch.

| # | Question | Lot bloqué |
|---|---|---|
| D1 | **`MIN_CASH` : 15 % ou 22 % ?** La spec générale §6 dit 15 % ; le cadrage de la phase 0 a retenu 22 % et c'est ce que `risk.ts` applique. Les deux valeurs coexistent dans le dépôt. | Q1 |
| D2 | La réconciliation §7 prévoit d'**annuler les ordres limit de plus de 24 h**. C'est une écriture sur l'exchange. En phase 1 sans exécution, aucun ordre n'existe : l'annulation est-elle implémentée et désarmée, ou repoussée en phase 3 ? | Q4 |
| D3 | §14 demande `jobs/liquidate.ts` **dès la phase 1**, mais il liquide, donc il exécute. Écrit et testé contre un mock sans jamais être armé, ou repoussé ? | Q7 |
| D4 | **Clés Coinbase** : le portefeuille dédié et la clé scopée existent-ils ? Avec quelles permissions en phase 1 — lecture seule, ou lecture + trade en prévision de la phase 3 ? La spec exige « jamais de permission de retrait ». | Q3 |
| D5 | **Neon** : qui crée le projet, et qui exécute `drizzle-kit push` ? La spec dit « depuis le poste, jamais depuis le job ». Une base de développement locale suffit-elle pour Q2, ou vise-t-on Neon directement ? | Q2 |
| D6 | **Brevo** : le domaine `olalpinesolutions` est-il authentifié SPF et DKIM ? Sans cela les rapports partent en spam et le lot ne peut pas prouver son critère. | Q5 |
| D7 | Le **seuil de drawdown à 25 %** déclenche « alerte et suspension des rééquilibrages ». La suspension est un comportement opérationnel, absent de `core/risk.ts` dont les neuf codes sont figés et couverts à 100 %. Où vit-elle : dans le job, dans la configuration, ou faut-il rouvrir la couche risque ? | Q6 |

D1 mérite une attention particulière : c'est une divergence **déjà présente dans
le dépôt**, pas une question ouverte. Laisser la configuration de phase 1 lire
15 % rendrait la production plus permissive que ce que la phase 0 a validé et
testé, sans qu'aucun test n'échoue.

## Lots

### Q1 — Frontières de phase 1 et configuration validée

- Dépend de : phase 0 intégrée.
- Décision préalable : **D1**.
- Diff estimé compté : ~450 lignes.
- Reprise : aucune.
- Fichiers prévus : `test/structure.test.ts`, `eslint.config.js`,
  `src/config/env.ts`, `test/config/env.test.ts`, `.env.example`,
  `docs/phase-1-frontieres.md`.

Résultat : le dépôt accepte `src/adapters/` et `src/jobs/` **sans perdre aucune
garantie structurelle**, et la configuration est validée au démarrage.

- Convertir le garde-fou C32 : les répertoires peuvent exister, mais `core`
  continue de ne rien importer d'eux (garantie déjà tenue par C1), et **aucun
  chemin d'exécution n'appelle une méthode de placement d'ordre**. Le contrôle
  doit être atteignable depuis un test, pas affirmé en commentaire.
- Étendre `eslint.config.js` : `adapters/` ne doit pas importer `jobs/`, et
  `jobs/` reste le seul point d'entrée. Ajouter les fixtures de lint
  correspondantes dans `test/lint/fixtures/`.
- `src/config/env.ts` : chargement et validation Zod de la configuration et des
  secrets attendus. Échec au démarrage si un secret manque, jamais un défaut
  silencieux. Trancher D1 et écrire la valeur retenue en toutes lettres.
- `.env.example` liste les variables sans aucune valeur réelle.

Critère de validation : `make test` passe ; un test échoue si un fichier de
`src/adapters/` ou `src/jobs/` appelle une méthode de placement d'ordre ; un test
échoue si une variable requise est absente de l'environnement.

Piège connu : la tentation est de remplacer C32 par un test de présence de
fichier, qui ne garantit rien. Le garde-fou utile porte sur les **appels**, pas
sur l'arborescence. Second piège : Zod entre au dépôt ici, donc le lockfile
bouge ; le documenter comme volume exclu.

### Q2 — Schéma Postgres et adapter Drizzle

- Dépend de : Q1.
- Décision préalable : **D5**.
- Diff estimé compté : ~700 lignes.
- Généré exclu : migrations Drizzle et lockfile.
- Fichiers prévus : `src/adapters/db.ts`, `src/adapters/schema.ts`,
  `test/adapters/db.test.ts`, `drizzle.config.ts`, `docs/base-de-donnees.md`.

Résultat : les quatre tables de la spec §4 existent, et un adapter typé les lit
et les écrit.

- Tables `decisions`, `orders`, `snapshots`, `cash_flows`, conformes au SQL de
  la spec, index unique `(run_date, strategy, is_shadow)` compris.
- L'adapter expose des opérations, pas un client brut : `recordDecision`,
  `latestSnapshot`, `recentCashFlows`, `pendingOrders`.
- Migrations exécutées **depuis le poste**, jamais depuis le job.

Critère de validation : les tests tournent contre un Postgres jetable lancé par
Compose ; un second appel d'écriture de décision pour le même
`(run_date, strategy, is_shadow)` est refusé par la base, pas par le code.

Piège connu : `numeric(20,8)` revient en `string` avec la plupart des drivers.
Le convertir en `Decimal` à la frontière et jamais en `number`, sous peine de
réintroduire le flottant que tout le noyau évite. C'est le point où la règle non
négociable d'`AGENTS.md` se perd le plus facilement.

Second piège : l'index unique **est** la garantie d'idempotence du job. Le
tester en tentant réellement le doublon, pas en lisant le DDL.

### Q3 — Adapters de lecture : Coinbase et marché

- Dépend de : Q1.
- Décision préalable : **D4**.
- Diff estimé compté : ~750 lignes.
- Généré exclu : lockfile (ccxt).
- Fichiers prévus : `src/adapters/coinbase.ts`, `src/adapters/market.ts`,
  `test/adapters/coinbase.test.ts`, `test/adapters/market.test.ts`,
  `docs/coinbase-lecture.md`.

Résultat : les soldes réels, les ordres ouverts et l'historique OHLCV sont
lisibles, et **rien d'autre n'est exposé**.

- `coinbase.ts` : lecture des soldes et des ordres ouverts. Aucune méthode de
  placement, d'annulation ou de retrait dans la surface publique du module.
- `market.ts` : OHLCV 200 jours, normalisé par `src/fixture/normalise.ts`, qui
  existe depuis la phase 0 et reste le seul contrôle.
- Toute paire non cotée en USDC est refusée à la frontière, en plus du rejet que
  `risk.ts` fait déjà.

Critère de validation : les tests tournent contre un mock d'API, sans réseau ;
un test assert que le module n'exporte aucune méthode d'écriture ; le
normaliseur refuse une série avec un trou, exactement comme en phase 0.

Piège connu : ccxt renvoie des `number` flottants pour les prix et les
quantités. La conversion en `Decimal` doit se faire **sur la chaîne d'origine**
quand l'API la fournit, pas sur le flottant déjà arrondi. Convertir un
flottant en `Decimal` fige l'erreur au lieu de l'éviter.

Second piège : un mock trop complaisant valide l'appel plutôt que le
comportement. Au moins un test doit rejouer une réponse réelle capturée, avec
ses champs inattendus et ses types surprenants.

### Q4 — Job quotidien en observation

- Dépend de : Q2, Q3.
- Décision préalable : **D2**.
- Diff estimé compté : ~850 lignes.
- Fichiers prévus : `src/jobs/daily.ts`, `src/jobs/reconcile.ts`,
  `test/jobs/daily.test.ts`, `test/jobs/reconcile.test.ts`, `package.json`.

Résultat : un run quotidien complet qui lit, décide, journalise et **ne place
rien**.

Enchaînement de la spec §8, étapes 1 à 5 et 7 : healthcheck de démarrage et log
du `git_sha`, réconciliation, lecture des soldes et prix, calcul des poids et
détection des `cash_flows` récents, puis pour chaque stratégie `decide()`,
`risk.validate()` et persistance dans `decisions` — **y compris quand le trigger
vaut `NONE`**. Puis benchmarks et snapshot.

**L'étape 6, l'exécution, n'existe pas en phase 1.** Ce n'est pas une étape
laissée vide : aucun code de placement n'est écrit.

Critère de validation : deux runs consécutifs le même jour produisent **une
seule** décision par stratégie et aucun ordre ; un run sur des soldes divergents
de plus de 1 % abandonne avant toute décision ; un run dont le trigger est
`NONE` écrit quand même sa ligne dans `decisions`.

Piège connu : le job vit hors de `core/`, donc la règle de pureté ne le protège
pas. C'est là que se glisse une lecture de l'horloge système. L'horloge est
injectée, y compris pour la `run_date` — sinon un run lancé à 23 h 59 UTC et son
rejeu à 00 h 01 portent deux dates et l'index unique ne protège plus rien.

Second piège : la réconciliation doit précéder **toute** décision, pas
l'exécution. Un run qui décide d'abord et réconcilie ensuite lit un état périmé.

### Q5 — Rapport quotidien Brevo

- Dépend de : Q4.
- Décision préalable : **D6**.
- Diff estimé compté : ~750 lignes.
- Fichiers prévus : `src/adapters/mailer.ts`, `src/report/daily-report.ts`,
  `test/report/daily-report.test.ts`, `test/adapters/mailer.test.ts`.

Résultat : le rapport quotidien de la spec §9, envoyé par l'API HTTP Brevo.

Contenu exigé : valeur totale, P&L jour et cumulé en **time-weighted return**,
poids actuels contre cibles contre bandes **avec la distance au prochain
déclenchement**, décision du jour même quand le trigger est `NONE`, comparaison
au hold BTC, au hold 50/50, au ladder et au DCA, Sharpe glissant 90 jours et max
drawdown. HTML inline minimal, lisible sur téléphone. Tag `daily-report`.

Le rendu réutilise les métriques de `core/benchmark.ts` ; il n'en recalcule
aucune.

Critère de validation : le rendu est testé sur un état figé et comparé à une
sortie attendue, sans réseau ; l'envoi est testé contre un mock d'API ; un test
vérifie que la distance au prochain déclenchement est correcte des deux côtés de
la bande.

Piège connu : la spec dit que la distance au prochain déclenchement est
« l'information la plus utile du rapport ». C'est aussi la seule qui demande un
calcul propre au rapport, donc la seule qui peut être fausse sans qu'aucun test
du noyau ne bronche. Elle mérite ses propres tests aux bornes.

Second piège : SMTP est explicitement écarté en serverless. Utiliser l'API HTTP
`/v3/smtp/email`, pas une bibliothèque SMTP.

### Q6 — Alertes ntfy, healthcheck et seuil de drawdown

- Dépend de : Q4.
- Décision préalable : **D7**.
- Diff estimé compté : ~600 lignes.
- Fichiers prévus : `src/adapters/notifier.ts`, `src/adapters/healthcheck.ts`,
  `src/jobs/alerts.ts`, `test/jobs/alerts.test.ts`,
  `test/adapters/notifier.test.ts`.

Résultat : les alertes de la spec §9 partent en push immédiat, et l'absence de
run est surveillée de l'extérieur.

Événements couverts : rééquilibrage exécuté — inapplicable en phase 1 mais le
chemin existe —, drawdown supérieur à 25 %, `REBALANCE_TOO_LARGE` déclenché,
divergence de réconciliation, jambe rejetée, job en échec.

Le healthcheck externe est pingé **en fin de run**. La surveillance ne doit pas
dépendre du système surveillé : c'est l'absence de ping qui alerte.

Critère de validation : chaque événement de la liste a son test et produit
exactement une notification ; un job qui échoue avant la fin ne ping pas le
healthcheck.

Piège connu : le seuil de drawdown déclenche « alerte **et suspension des
rééquilibrages** ». La suspension est un comportement, pas une notification. En
phase 1 rien ne s'exécute, donc elle n'a aucun effet observable — d'où le risque
de l'écrire sans jamais la tester et de découvrir en phase 3 qu'elle ne marche
pas. Elle doit être testable dès maintenant, sur son effet sur la décision, pas
sur l'exécution. C'est l'objet de la décision D7.

### Q7 — Sortie propre, non armée

- Dépend de : Q3, Q4.
- Décision préalable : **D3**.
- Diff estimé compté : ~500 lignes.
- Fichiers prévus : `src/jobs/liquidate.ts`, `test/jobs/liquidate.test.ts`,
  `docs/sortie-propre.md`.

Résultat : la procédure de sortie de la spec §14 existe et est testée, **sans
pouvoir s'exécuter en phase 1**.

Enchaînement : annulation des ordres ouverts, liquidation des positions vers
USDC en limit post-only, désactivation du cron trigger, rapport final
récapitulant les cessions.

Critère de validation : le déroulé complet est testé contre un mock ; un test
assert que le module **refuse de tourner** tant que la phase 1 est active, et
que ce refus n'a pas de paramètre de contournement.

Piège connu : c'est le lot qui contredit le plus frontalement le « aucune
exécution » de la phase 1. La spec le veut écrit tôt pour une bonne raison — « le
jour où on veut arrêter, on n'improvise pas un script à la main » — mais un
script de liquidation à moitié armé est plus dangereux qu'un script absent. Le
verrou doit être structurel, comme celui de `risk.ts` : aucun drapeau, aucun
`--force`. La décision D3 tranche s'il est écrit maintenant ou repoussé.

## Couverture des exigences de la spec

| Section de la spec | Exigence | Lot |
|---|---|---|
| §2 | frontière `core` / `adapters` / `jobs` | Q1 |
| §3 | Zod pour la config et les payloads | Q1 |
| §3 | Drizzle, migrations depuis le poste | Q2 |
| §3 | ccxt Coinbase Advanced | Q3 |
| §3 | Brevo API HTTP, pas SMTP | Q5 |
| §3 | ntfy | Q6 |
| §4 | tables `decisions`, `orders`, `snapshots`, `cash_flows` | Q2 |
| §4 | index unique, idempotence du run | Q2, Q4 |
| §4 | `cash_flows` et TWR, un apport n'est pas une performance | Q4, Q5 |
| §6 | valeurs de la couche risque appliquées par la config | Q1 (D1) |
| §6 | alerte et suspension au drawdown de 25 % | Q6 (D7) |
| §7 | portefeuille dédié, clé scopée, jamais de retrait | Q3 (D4) |
| §7 | paires exclusivement en USDC | Q3 |
| §7 | `client_order_id` déterministe | acquis phase 0 (`order-id.ts`) |
| §7 | rééquilibrage partiellement exécuté, sans compensation | acquis phase 0 |
| §7 | réconciliation avant toute décision | Q4 |
| §7 | annulation des ordres de plus de 24 h | Q4 (D2) |
| §8 | enchaînement du run, étapes 1 à 5 et 7 | Q4 |
| §8 | étape 6, exécution | **hors phase 1** |
| §8 | timeout 5 min, max retries 0 | phase 2 |
| §9 | rapport quotidien et son contenu | Q5 |
| §9 | distance au prochain déclenchement | Q5 |
| §9 | alertes push immédiates | Q6 |
| §9 | healthcheck externe, surveillance de l'absence | Q6 |
| §10 | Neon, région eu-central-1 | Q2 (D5) |
| §10 | Scaleway, Docker, GitHub Actions | phase 2 |
| §11 | jamais de paire EUR | Q3, acquis phase 0 |
| §11 | export CSV des cessions | hors phase 1 |
| §14 | sortie propre `liquidate.ts` | Q7 (D3) |

## Ordre et concurrence

- **Vague 1** : Q1 seul. Il déplace le garde-fou structurel que tous les autres
  lots franchissent ; le paralléliser exposerait chaque lot suivant au choix
  entre casser la suite et désarmer le garde-fou.
- **Vague 2** : Q2 et Q3, indépendants l'un de l'autre. Base de données d'un
  côté, adapters de lecture de l'autre, fichiers disjoints.
- **Vague 3** : Q4 seul. Il consomme Q2 et Q3 et écrit le job principal.
- **Vague 4** : Q5, Q6 et Q7, indépendants entre eux. Trois workers, le plafond.

Trois workers simultanés maximum, revues comprises. Le coordinateur sérialise
les écritures sur les fichiers communs — `package.json`, `.env.example`,
`eslint.config.js`, `test/structure.test.ts` — même quand les lots n'ont aucune
dépendance métier entre eux. Q2, Q3 et Q5 ajoutent chacun une dépendance, donc
touchent le lockfile : leurs merges se sérialisent.

Sept lots, sept décisions préalables. Aucune estimation en « une soirée » : la
spec en annonce une pour toute la phase 1, ce que la phase 0 a déjà démenti pour
son propre périmètre. Mesurer les temps réels pendant les cycles Orca.
