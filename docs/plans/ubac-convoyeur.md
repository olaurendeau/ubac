# Plan : ubac-convoyeur

Spec de référence : [`docs/specs/ubac-convoyeur.md`](../specs/ubac-convoyeur.md)
(#74), **vingt-trois critères CV1 à CV23**, décisions D1 à D3, Q1 à Q10 et DC1
à DC9 closes le 2026-09-28, incertitudes U1 à U9. Plan établi le 2026-09-28,
`main` à `f5e3721`, production en v0.3.2 (plafond 11 %, derniers apports).
Revu le 2026-09-28 après la revue Codex de `d4efd79` : le repli « Y8 sans S13 »
est retiré (point 4), le rôle Neon perd ce qu'il tenait de `PUBLIC` (Y1, OP3),
et Y7a reste séparé d'Y7b pour une raison dite dans Y7a.

La spec est la référence de vérité ; ce plan est une hypothèse de découpage.
Aucun code n'est écrit ici. Chaque lot cite les `CV` qu'il couvre, et la table
de couverture est exhaustive.

## État de départ, constaté et non supposé

Mesure du 2026-09-28 sur ce poste, `f5e3721` : `./scripts/dev.sh npm test` →
**1 528 tests passés, 32 ignorés**, 44 fichiers dont 2 ignorés, 23,8 s.

Ce que le dépôt porte déjà, et qu'aucun lot ne refait :

| Acquis | Fichier | Ce qu'il donne au convoyeur |
|---|---|---|
| Refus de toute clé qui transfère | `src/adapters/coinbase.ts`, `permissionsFrom` | K1 : la clé du convoyeur posée dans Ubac est refusée avant toute lecture. **CV3 cite la sonde existante**, aucun lot ne la réécrit |
| Fenêtre de flux faite d'instants | `src/jobs/snapshot.ts`, `netFlow()` | K3 : une ligne horodatée à l'instant du transfert tombe dans `]photo, run]` quelle que soit l'heure (CV12) |
| Gel de A sur tout apport | `src/core/strategy/rebalance.ts`, `lastFunding()` | K4 : la ligne du convoyeur gèle déjà (CV14). **Le noyau n'est pas touché** |
| « Derniers mouvements » | `src/report/daily-report.ts` (#73, #76) | K8 : l'apport du convoyeur apparaît au rapport sans rien toucher |
| Idempotence par la base | `src/adapters/db.ts`, `isUniqueViolation` | le motif de l'index **nommé et exporté**, repris pour `cash_flows` et pour le journal |
| Ports inertes, mode au seul point de composition | `src/adapters/inertes.ts`, `src/jobs/daily-main.ts` (S5) | la forme du `DRY_RUN` du convoyeur (CV16) |
| Canal ntfy et client HTTP borné | `src/adapters/notifier.ts`, `src/adapters/http.ts` | le canal d'Ubac, et `HttpSend` avec son délai |
| Chaîne `test` → `build` → `deploy` sur tag `v*` | `.github/workflows/ci.yml`, `test/ci/` (R1 à R3) | une image, **une** définition, contrôles avant et relecture après (K7) |
| Lecture des transitions d'ordre | S8a (#68), S8b (#69) | la frontière des flux n'attend plus S8a : **G4 est sans objet** |
| ccxt 4.5.78 | `package.json` | les méthodes implicites `brokerage/portfolios/move_funds` et `brokerage/transaction_summary` existent (constaté dans `node_modules/ccxt/js/src/coinbase.js`) |

Ce que le dépôt **n'a pas** : aucune écriture de `cash_flows`, ni origine ni clé
naturelle (K2) ; aucun arbre de code hors d'Ubac ; aucune route d'ordre au
marché — `CreateOrderBody` n'admet que `limit_limit_gtc` avec `post_only: true`,
et c'est voulu ; aucun rôle de base autre que celui d'Ubac ; aucune seconde
image ni seconde définition ; et, côté phase 3, **ni S9, ni S13** : l'étape 6 de
`daily.ts` ne consulte pas `resync`, donc **E60 n'est pas tenu aujourd'hui**
(constaté : `resync` n'est lu que pour marquer les intentions et alerter).

## Ce que le plan prend en compte, revérifié dans le code

### 1. Le convoyeur est un second arbre, pas un module d'Ubac

La surface d'écriture d'Ubac est **énumérée et close** (`READ_ROUTES`,
`WRITE_ROUTES`, E10, E11) ; y ajouter un ordre au marché et `move_funds`
desserrerait exactement ce que la phase 3 a fermé. Le convoyeur vit donc dans
**`src/convoyeur/`**, avec son adapter, son chargeur de configuration et son
point de composition, et deux frontières tenues par `eslint.config.js` :

- rien de `src/core/`, `src/jobs/`, `src/adapters/`, `src/report/` n'importe
  `src/convoyeur/` ;
- `src/convoyeur/` n'importe de `src/adapters/` que `schema.ts` (les tables) et
  `http.ts` (le client borné), et de `src/core/` que des types. Jamais
  `coinbase.ts`, `db.ts`, `execute.ts`, ni `src/jobs/`.

Un seul `package.json` et une seule compilation, deux images (Q7) : chaque image
retire l'arbre de l'autre (Y6), ce qui fait de CV3 un constat sur l'image et pas
seulement sur le point d'entrée.

### 2. Le journal précède chaque appel, et il est en ajout seul

DC6 demande un journal durable écrit **avant** chaque appel à l'exchange. Le
plan le prend en **ajout seul** : une table `convoyeur_journal`, une ligne par
étape d'un convoyage, index unique `(convoyage, etape)`. L'état courant est la
dernière étape ; rejouer une étape déjà écrite bute sur l'index. Le rôle du
convoyeur n'a donc besoin que de `SELECT` et `INSERT` sur son journal, jamais
d'`UPDATE` — Q9 en sort plus étroit que la spec ne l'exige.

Étapes proposées, dans l'ordre : `ACHAT_DEMANDE` (avant l'ordre, porte le
`client_order_id`), `ACHETE` (après lecture de l'ordre rempli : `filled_size`,
`filled_value`, `total_fees`, identifiant d'exchange), `TRANSFERT_DEMANDE`
(avant `move_funds`, porte l'instant de la demande et le montant), `TRANSFERE`
(après relecture du solde : instant constaté), `ENREGISTRE` (après l'écriture de
`cash_flows`), et `EN_PANNE` (invariant non rétabli, motif). Un convoyage est
identifié par le **jour UTC du passage qui l'ouvre** ; l'index unique sur ce
jour fait de DC8 (« un passage, un convoyage ») une propriété de la base, pas
d'un `if`.

### 3. La reprise se lit sur l'exchange, et l'instant d'un transfert repris aussi

DC3 rend le transfert reprenable sans clé d'idempotence : dans *Primary*, l'USDC
n'appartient qu'au convoyeur. La table de reprise, que Y2 écrit en fonction pure
et que Y4b branche :

| Dernière étape | USDC relu dans *Primary* | Action |
|---|---|---|
| `ACHAT_DEMANDE` | — | relire l'ordre par `client_order_id` ; recréer avec le même identifiant rend l'ordre existant (S5), jamais un second |
| `ACHETE` ou `TRANSFERT_DEMANDE` | `filled_size + p` | transférer `filled_size`, jamais `p` |
| `TRANSFERT_DEMANDE` | `p` | transfert fait : écrire `TRANSFERE` |
| `ACHETE` | `p` | incohérent (l'USDC est parti sans demande) : `EN_PANNE`, `urgent` |
| toute étape | ni `p` ni `filled_size + p` | `EN_PANNE`, `urgent`, aucun transfert (CV10) |
| `TRANSFERE` | — | écrire `cash_flows` (idempotent par la clé naturelle), puis `ENREGISTRE` |
| aucun convoyage ouvert | `≥ 1`, négatif ou illisible | USDC étranger : refus, `urgent`, aucun achat (CV10) |
| aucun convoyage ouvert | `p` | poussière ignorée et dite dans la notification ; la décision suit l'EUR (DC10) |

`p` est une poussière, `0 ≤ p < 1` USDC (DC10, décision de l'opérateur du
2026-10-03, qui remplace les `0` et `= filled_size` d'origine). Une seule
fonction, `constater`, la lit pour la table et pour la relecture après
`move_funds`. Un `filled_size` sous 1 USDC est une panne : les deux premières
lignes seraient vraies à la fois.

**L'instant d'un transfert repris** (DC5) : la réponse de `move_funds` ne porte
ni identifiant ni horodatage (S7). L'instant retenu est **celui de
`TRANSFERT_DEMANDE`**, écrit juste avant l'appel ; un transfert constaté fait à
la reprise a eu lieu entre cette demande et la panne. C'est un ajustement
technique au même objectif que DC5, et Y4b le documente.

**Un passage fait au plus une chose : finir, ou commencer.** DC6 dit « chaque
passage commence par finir le convoyage que le journal laisse ouvert, avant d'en
commencer un autre » ; DC8, « un passage, un convoyage ». Le plan lit les deux
de la façon la plus étroite : un passage qui a repris un convoyage ne lance pas
d'achat. L'apport suivant attend un jour, et aucun bug de reprise ne peut
chaîner deux achats dans un passage.

### 4. CV15 et S13 : un ordre de livraison, pas une dépendance de code

La brief demande si S13 doit être construit avant CV15. **Réponse : CV15 peut se
coder sans S13, mais il doit être livré après lui**, pour trois raisons
constatées :

- **Le code de CV15 ne lit pas E60.** Il décide si `RECONCILIATION_DRIFT` part ;
  la resynchronisation, `ETAT_RESYNCHRONISE` et E60 « ne changent pas ». Sans
  S13, « ne change pas » est tenu trivialement — E60 n'existe pas.
- **T6 confie le refus d'exécuter au texte de `RECONCILIATION_DRIFT`.** Un jour
  d'apport, CV15 tait cette alerte. Si S13 vient après, il écrit son refus dans
  une alerte qui ne part plus, et le jour sans exécution devient muet —
  exactement ce que T6 refusait. Si S13 vient avant, Y8 déplace la phrase vers
  le rapport, qui part ce jour-là. **S13 d'abord, Y8 ensuite**, comme N10 du
  plan des flux l'avait déjà conclu.
- **U6 fait de S13 fusionné une condition du premier convoyage réel.** Il doit
  l'être avant fin novembre de toute façon.

S13 est estimé à ~400 lignes par le plan de phase 3 et partage `daily.ts` avec
S9. **Y8 part strictement après S13 fusionné, sans repli** : un Y8 anticipé
tairait l'alerte où S13 écrirait ensuite son refus, et rien ne sérialiserait ni
ne sonderait la correction commune. S13 est donc **prioritaire sur les workers
libres des vagues 3 à 6** (voir « Ordre, vagues et sérialisation »). **Si S13
glisse, c'est OP6 qui glisse** — la mise en réel attend le virement suivant, ce
que U6 impose déjà — jamais Y8 qui part avant lui.

### 5. Neon : un rôle créé par SQL, et un `push` qui ne connaît pas les droits

- **Les droits ne sont pas dans le schéma Drizzle.** `drizzle-kit push` ne
  gère pas les `GRANT`, et un `push` qui recrée une table les efface. Les droits
  vivent dans un script SQL **idempotent** du dépôt, `scripts/role-convoyeur.sql`,
  sans mot de passe, rejoué après chaque `push` qui touche `cash_flows` ou le
  journal.
- **Un rôle créé depuis la console Neon hérite de `neon_superuser`**, qui
  porterait bien plus que Q9 (à constater sur Neon, pas à supposer). Le rôle se
  crée donc **par SQL** depuis le poste, et l'étape OP3 constate
  `pg_has_role('ubac_convoyeur', 'neon_superuser', 'member') = false`.
- **Le rôle n'a aucun `SELECT` sur `cash_flows`** (Q9 : « `INSERT` sur
  `cash_flows` et son journal, rien d'autre »). L'écriture idempotente passe donc
  par un `INSERT` simple dont la violation 23505 **sur l'index nommé** vaut
  `ALREADY_RECORDED` — ni `RETURNING`, ni lecture préalable, qui exigeraient un
  `SELECT`.
- **« Rien d'autre » inclut ce que `PUBLIC` donne à tout rôle** : `EXECUTE`
  sur les fonctions, `TEMPORARY` sur la base, et ce que Neon y ajoute. Le script
  le retire (Y1) et OP3 constate par `has_*_privilege` qu'une table non autorisée
  reste fermée au rôle.
- **La sonde CV19 tourne contre le Postgres local** : `ubac_dev` y est
  superutilisateur, le test crée le rôle par le script du dépôt et l'éprouve par
  `SET ROLE`, sans mot de passe.

### 6. Le mois d'octobre : le `DRY_RUN` voit l'EUR avant le geste manuel

U6 : le virement du ~27/10 est convoyé à la main une dernière fois **et** vu par
le `DRY_RUN` (CV23). Les deux se contrarient si l'opérateur agit avant 19:00 : le
passage ne voit plus d'EUR, CV23 n'est pas constaté. **L'ordre opérateur est donc
imposé** (OP5) : attendre le passage de 19:00 qui voit l'EUR, puis convertir
dans *Primary* (DC1, jamais dans `ubac-agent`), transférer l'USDC, et saisir la
ligne `cash_flows` comme aujourd'hui, **avant 07:00**. Un USDC laissé dans
*Primary* après le geste, dès 1 USDC, serait lu le soir suivant comme étranger
(CV10) ; en dessous, c'est une poussière, ignorée et dite (DC10).

Pour que la saisie manuelle d'octobre reste le geste d'aujourd'hui, **la colonne
d'origine a `OPERATEUR` pour défaut** et la clé naturelle est nulle pour les
lignes de l'opérateur (Y1) : l'`INSERT` que l'opérateur tape déjà continue de
passer, et les lignes existantes prennent l'origine qui est la leur.

### 7. Ce qui entre du plan des flux, et ce qui reste en suite optionnelle

Le plan `docs/plans/ubac-flux-non-enregistres.md` et sa spec sont **sur la
branche locale `olaurendeau/ubac-flux-cadrage`, non poussée, non fusionnée**.
Ce plan n'en reprend que ce que la section « Effet sur le plan des flux » de la
spec du convoyeur rend nécessaire.

| Lot des flux | Ici | Forme |
|---|---|---|
| **N2** | **Y1** (modifié) | origine à trois valeurs `OPERATEUR` (défaut), `CONVOYEUR`, `DETECTE` (réservée à N8) ; clé naturelle nullable sous index unique nommé ; lecture de l'origine validée à la frontière. **Pas d'écrivain dans `UbacDatabase`** : le seul écrivain est celui du convoyeur (Y4a). L'écrivain `DETECTE` / `OPERATEUR` reste à N3 et N8 |
| **N10** | **Y8** (réduit) | seule la part « divergence entièrement expliquée par des flux **enregistrés** » ; sans N8, sans N9 ; après S13 (point 4) |
| N1 | suite optionnelle | inutile à l'apport (DC1) ; utile pour une devise égarée |
| N3, N4, M1 | suite optionnelle | outil des retraits (F16, moitié retrait). M1 est sans objet pour le convoyeur (Q7) |
| N5 à N8 | suite optionnelle | hors du chemin de l'apport ; filet de U9 |
| N9 | suite optionnelle | partiellement fait par #73 et #76 (retraits compris) ; reste l'origine |
| N10, part « flux détecté » | suite optionnelle | dépend de N8 |

**Les questions G1 à G4 ne sont pas reposées**, aucune n'étant nécessaire à un
lot de ce plan : **G1** est sans objet (DC5 fixe l'instant du convoyeur) ;
**G2** reste ouverte pour la saisie — Y1 laisse la clé naturelle nulle pour
`OPERATEUR` sans préjuger de sa forme future ; **G3** est tranchée par la spec
elle-même pour ce qui nous concerne (CV15 : « une divergence que les flux
n'expliquent qu'en partie crie comme aujourd'hui ») et reste au plan des flux
pour le lendemain d'exécution ; **G4** est sans objet depuis S8a (#68).

**À répercuter dans le plan des flux quand il sera repris** : N2 y devient
« l'écrivain `DETECTE` / `OPERATEUR` dans `UbacDatabase` », le schéma étant
acquis ; N10 y perd sa part « flux enregistrés ».

## Estimations : calibrées sur les livraisons réelles

L'étalon des phases 1 à 3 : les frontières externes débordent d'un facteur 1,5
à 2 (S7 annoncé ~1 000 → 2 117 en trois PR), le branchement dans un run coûte
200 à 250 lignes, une section de rapport ~200 avec son lexique. **Chaque lot vise
700 lignes au plus**, déjà corrigées, pour qu'un débordement de 40 % reste sous
le plafond. Un lot qui franchit 1 000 lignes comptées se redécoupe selon la ligne
« Redécoupe » qu'il porte.

## Convention de livraison

Une PR par lot, **1 000 lignes ajoutées + supprimées** au plus, code, tests et
documentation compris. Tout par Docker (`make …` ou `./scripts/dev.sh …`) :
`make typecheck` et `make test` sur chaque lot.

- **`make test-db` obligatoire sur Y1, Y4a et Y8** : l'index unique de la clé
  naturelle, celui du journal et les droits du rôle sont les défenses de CV11 et
  CV19, et les tests de base sont ignorés hors base et hors chaîne (D2 de la
  phase 2). Les laisser à `make test` reviendrait à ne pas les exécuter.
- **`make coverage` n'est exigé d'aucun lot** : **aucun ne touche
  `src/core/`**. La carence et le chaînage lisent `cash_flows` tels quels. Un lot
  qui toucherait `core/` en cours de route exécute `make coverage` et vérifie les
  100 % de `risk.ts`, ou il n'est pas fini.
- **Audit proportionné** (règle du 2026-09-14) : tout lot fournit la preuve par
  mutation ; **tous les lots sauf Y9** touchent l'argent, un secret ou un
  garde-fou et fournissent en plus l'audit affirmation / variantes / sondes.
- **Aucun secret, à aucune étape** : ni dans le dépôt, ni dans un journal, ni
  dans une notification, ni dans un message Orca. La clé du convoyeur n'est
  jamais lue par un agent ; les mesures OP2 sont faites par l'opérateur.

## Décisions préalables

Posées au coordinateur le 2026-09-28 (`orca orchestration ask`) et
**tranchées le même jour** par l'opérateur : **1, 1, 1, 1, 2**. Elles ne se
reposent pas.

| # | Question | Avant | Options | Réponse |
|---|---|---|---|---|
| **DP1** | « Entièrement expliquée » (CV15) | Y8 | 1) la ligne USDC, flux de `]photo, run]` ajoutés au cache, **ne diverge plus au sens de Q10** (≤ 1 %, même formule, même seuil) · 2) écart résiduel **nul** au centime | **1** (recommandée). Un seuil, une formule : E39 inchangé. Avec 2, le lendemain d'une exécution qui tombe un jour d'apport crie toujours, et un centime d'arrondi de frais suffit à faire crier |
| **DP2** | Outil des mesures MC1 à MC3 | Y10 | 1) **script commité** hors `src/` et hors image, relu, lancé par l'opérateur sur le poste · 2) requêtes décrites dans la doc, script jetable non commité | **1** (recommandée). Un outil qui tente d'envoyer de l'argent doit être relu ; un script jetable ne l'est jamais |
| **DP3** | Calendrier des mesures | OP4 | 1) **MC1 et MC2 avant que la clé entre dans Scaleway**, donc avant le `DRY_RUN` d'octobre · 2) `DRY_RUN` d'abord, mesures avant novembre | **1** (recommandée). Un `DRY_RUN` ne transfère rien, mais sa clé le peut : si MC1 échoue, elle ne doit jamais avoir été déployée |
| **DP4** | Le `DRY_RUN` notifie-t-il ? | Y5 | 1) **oui**, préfixe « convoyeur DRY_RUN » · 2) non, silencieux comme celui d'Ubac | **1** (recommandée). C'est le signal du geste manuel d'octobre (point 6) ; CV17 le permet, un passage qui voit l'EUR « fait quelque chose » |
| **DP5** | Mise en réel | Y5, Y7b, OP6 | 1) le mode est **épinglé dans `ci.yml`** et contrôlé au déploiement ; passer au réel = une PR qui cite MC1 à MC3 · 2) geste console seul, rapporté dans Orca | **2** (la recommandation était 1). Le réel est l'argument `--reel` ajouté au déclencheur par l'opérateur (OP6). **Le mode reste visible et contrôlé sans bloquer** : il est journalisé au démarrage de chaque passage, porté par chaque notification (Y5), lu et rapporté par chaque déploiement, dont la relecture constate qu'il n'a pas changé pendant le déploiement (Y7b). Le lot Y11, qui épinglait le mode, est retiré |

## Lots

Douze lots, préfixe **Y** (« convo**Y**eur ») : `CV` est pris par les critères,
`K`, `N`, `P` à `S` par les constats et les phases. Les numéros ne se
recompactent pas ; **Y11**, qui épinglait le mode, est retiré par DP5 = 2.
Les étapes opérateur sont préfixées **OP**.

### Y1 — `cash_flows` gagne origine et clé naturelle ; le journal ; le rôle Neon

**Dépend de** : rien. **Reprend** : N2 du plan des flux, modifié. · **Décisions** :
DC7, Q9, U5. · **Critères** : **CV19** ; CV11, moitié base (la clé refuse le
doublon). · **Audit** : argent + garde-fou (l'indice et la carence lisent la
table ; le rôle borne une clé de base) → mutation **+** audit complet ;
**`make test-db` obligatoire**. · **Diff estimé compté** : **~650 lignes**
(dont ~50 pour le retrait de `PUBLIC` et son inventaire).
**Fichiers prévus** : `src/adapters/schema.ts` (`origin`, `natural_key`,
`CASH_FLOWS_NATURAL_KEY_INDEX` exporté, table `convoyeur_journal` et son index
exporté), `src/adapters/db.ts` (`CashFlowRecord` gagne l'origine, validée à la
frontière comme `side`), `scripts/role-convoyeur.sql` (neuf),
`test/adapters/role-convoyeur.test.ts` (neuf, base),
`test/adapters/schema-contraintes.test.ts`, `test/adapters/db.test.ts`,
`docs/base-de-donnees.md` §2, §5 et §6, `docs/deploiement.md` §2.

**Résultat** : `cash_flows` porte `origin` (`OPERATEUR` par défaut, `CONVOYEUR`,
`DETECTE`) et `natural_key` (nullable), sous un index unique nommé ; une
contrainte `CHECK` exige une clé naturelle pour toute ligne `CONVOYEUR`. Le
journal `convoyeur_journal` existe avec son index unique `(convoyage, etape)` et
l'index unique du jour de convoyage. Le script SQL crée, s'il n'existe pas, le
rôle `ubac_convoyeur` **sans mot de passe** et lui donne exactement : `USAGE` sur
le schéma, `INSERT` sur `cash_flows`, `SELECT` et `INSERT` sur son journal.

**Ce que le rôle hérite de `PUBLIC` est retiré**, pour que « `INSERT` sur
`cash_flows` et son journal, rien d'autre » (Q9) se vérifie au lieu de se
supposer. Le script, idempotent :

- `REVOKE CREATE ON SCHEMA public FROM PUBLIC` (déjà le défaut en Postgres ≥ 15,
  rejoué pour ne pas en dépendre) ; `USAGE` reste accordé **nommément** au rôle ;
- `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC`, idem pour
  `SEQUENCES`, et `REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC` ;
- `ALTER DEFAULT PRIVILEGES FOR ROLE <propriétaire des tables> IN SCHEMA public
  REVOKE …  FROM PUBLIC` sur tables, séquences et fonctions, pour qu'une table
  ajoutée par un `push` futur n'ouvre rien au rôle ;
- `REVOKE TEMPORARY ON DATABASE <base> FROM PUBLIC` ; `CONNECT` est accordé
  nommément au rôle et **laissé à `PUBLIC`** — il n'ouvre aucune donnée, et le
  retirer risquerait de couper des rôles de Neon que le dépôt ne connaît pas.

Ce que Neon accorde de plus à `PUBLIC` (extensions installées dans `public`,
fonctions propres à Neon) n'est pas supposé : OP3 le lit par `aclexplode` avant
de rejouer le script, et le rapporte. Le propriétaire des tables — le rôle
d'Ubac — garde ses droits de propriétaire, que `REVOKE … FROM PUBLIC` ne touche
pas.

**Validation** : CV19 contre la base locale, par `SET ROLE` : `INSERT` d'une
ligne `CONVOYEUR` accepté ; `UPDATE`, `DELETE` et `SELECT` sur `cash_flows`
refusés (42501) ; toute écriture **et toute lecture** de `decisions`,
`snapshots`, `orders` refusées ; `SELECT` et `INSERT` du journal acceptés,
`UPDATE` et `DELETE` refusés ; `CREATE TABLE` dans `public` et `CREATE TEMP
TABLE` refusés ; **inventaire exhaustif** : pour chaque table, séquence et
fonction du schéma `public`, `has_table_privilege`, `has_sequence_privilege` et
`has_function_privilege` du rôle valent `false`, hors de la liste blanche
(`INSERT` sur `cash_flows`, `SELECT` et `INSERT` sur le journal), et une
fonction créée **après** le script n'est pas exécutable par le rôle (défauts :
Postgres accorde `EXECUTE` à `PUBLIC` sur toute fonction neuve, rien sur une
table neuve). Le rôle
d'Ubac garde ses droits après le script. Le script rejoué deux fois ne change rien. Deux
lignes de même clé naturelle : la seconde lève 23505 **sur l'index nommé** ; une
ligne `CONVOYEUR` sans clé est refusée par la base ; une ligne insérée sans
origine prend `OPERATEUR` ; une origine inconnue relue est refusée à la
frontière. **Mutations** : ajouter `UPDATE` au `GRANT` du journal — la sonde
rougit ; retirer l'index unique — la sonde d'idempotence rougit, **sous
`make test-db` seulement** ; accepter une origine inconnue à la lecture — la
sonde de frontière rougit ; retirer le `REVOKE … ON ALL TABLES … FROM PUBLIC`
après un `GRANT SELECT … TO PUBLIC` posé par le test — l'inventaire rougit ;
retirer l'`ALTER DEFAULT PRIVILEGES` — la sonde de la fonction créée après
rougit.

**Pièges.** (1) **Le schéma se pousse sur Neon avant tout tag qui contient Y4a**,
depuis le poste, avec TTY (`docs/deploiement.md` §2) ; le script de rôle se
rejoue ensuite (OP3). (2) **Des lignes existent** : compter `cash_flows` sur
Neon avant le `push` et le rapporter dans Orca ; le défaut `OPERATEUR` leur donne
leur vraie origine (point 6) — le constater, pas le supposer. (3) **La clé ne
remplace pas `id`**, qui reste la clé primaire uuid, comme dans `decisions`.
(4) **`drizzle-kit push` recrée parfois une table** et efface ses droits :
`docs/base-de-donnees.md` §5 dit de rejouer le script après tout `push`.
(5) **`toCashFlow()` de `daily.ts` laisse tomber l'origine** : le noyau n'en a
pas besoin, `core/types.ts` n'est pas touché, et `daily.ts` ne l'est pas non
plus si le champ est ajouté sans casser sa lecture. (6) **Une politique RLS**
(« le rôle n'écrit que des lignes `CONVOYEUR` positives ») serait une défense de
plus ; elle n'est retenue que si `drizzle-kit push` la laisse intacte — à
constater dans le lot, sinon noté comme limite. (7) `docs/base-de-donnees.md` §6
promet que « les flux viendront de l'exchange, avec l'identifiant de
transfert » : S7 dit qu'il n'y en a pas ; la phrase se réécrit. (8) **Les
`REVOKE … FROM PUBLIC` valent pour toute la base**, pas pour le seul rôle du
convoyeur : le rôle d'Ubac est propriétaire des tables et ne dépend pas de
`PUBLIC`, ce qu'OP3 constate sur Neon **avant** de rejouer le script ; si ce
n'est pas le cas, le script accorde d'abord nommément au rôle d'Ubac ce qu'il
tenait de `PUBLIC`, et le lot le dit.

**Redécoupe** : **Y1a** schéma et frontière ; **Y1b** rôle, script et sonde CV19.

### Y2 — Les règles du convoyeur, en fonctions pures

**Dépend de** : rien. · **Décisions** : Q3, Q6, Q8, DC2, DC3, DC4, DC8, DC9. ·
**Critères** : CV1, CV2, CV5, CV6 (l'identifiant), CV7, CV8, CV9, CV10, CV13 **sur
les règles** — clos au branchement (Y4b, Y5) ; les textes de CV17. · **Audit** :
argent + garde-fou → mutation **+** audit complet. · **Diff estimé compté** :
**~600 lignes**.
**Fichiers prévus** : `src/convoyeur/regles.ts` (neuf),
`src/convoyeur/types.ts` (neuf : `EurAmount`, `UsdcAmount` du convoyeur, étapes
du journal), `test/convoyeur/regles.test.ts` (neuf).

**Résultat** : sans IO ni horloge, des fonctions qui disent : si une clé est
acceptable (portefeuille attendu, `portfolio_type` `DEFAULT`, `can_transfer` le
booléen `true`, `can_trade` et `can_view` aussi) ; si un couple source /
destination est admis (égalité exacte aux deux UUID configurés) ; quoi faire d'un
passage — rien (EUR < 100), acheter 100, reprendre selon la table du point 3, ou
refuser ; le `client_order_id` d'un convoyage, dérivé du jour par un domaine
versionné `ubac.convoyeur.client-order-id.v1` (le motif de
`src/core/order-id.ts`, recopié et non importé) ; le montant à transférer ; le
surplus laissé ; le texte des notifications (EUR débité, USDC reçu, frais, étape,
EUR laissé).

**Validation** : CV1, une sonde par refus (portefeuille, type, `can_transfer`
absent, `"true"`, `false`) ; CV2, une destination altérée d'un caractère refusée ;
CV5, 99,99 EUR → rien ; CV7, **fast-check** : pour tout solde EUR et tout état de
journal, l'EUR engagé par un passage vaut 0 ou exactement 100, jamais plus ;
250 EUR sur trois passages → 100, 100, rien avec 50 signalés ; CV6, même jour →
même identifiant, valeur figée par un test ; CV8, le montant est `filled_size`,
en `Decimal`, avec des grandeurs décimalement sensibles ; CV9 et CV10, chaque
ligne de la table du point 3 a sa sonde. **Mutations** : comparer les UUID en
préfixe — la sonde du caractère altéré rougit ; accepter `can_transfer: "true"` —
sa sonde rougit ; engager `min(EUR, 200)` — la propriété rougit.

**Pièges.** (1) **Seuil inclusif** : 100 EUR pile convoie (« EUR ≥ 100 », Q6).
(2) **`available`, pas `total`** : un EUR SEPA crédité mais bloqué est « rien à
faire » (U3). (3) **Aucun `number`** : les montants EUR et USDC sont des
`Decimal` marqués, distincts de ceux d'Ubac, et les règles `eslint` du noyau
s'appliquent à `regles.ts` par le glob du lot Y3. (4) **Les frais d'un `BUY`
USDC-EUR sont en EUR** : `filled_size` est l'USDC reçu tel quel, et un USDC
relu ≠ `filled_size` est une anomalie, pas un arrondi à tolérer. (5) Un passage
qui reprend ne commence rien (point 3).

### Y3 — L'adapter Coinbase du convoyeur, et sa frontière

**Dépend de** : rien. · **Décisions** : D1, D2, Q7, Q8, DC2. · **Critères** :
**CV4** ; CV1 et CV2, moitié adapter ; CV6, moitié corps d'ordre. · **Audit** :
argent + garde-fou → mutation **+** audit complet. · **Diff estimé compté** :
**~700 lignes**.
**Fichiers prévus** : `src/convoyeur/coinbase.ts` (neuf),
`test/convoyeur/coinbase.test.ts` (neuf), `test/convoyeur/fixtures/` (neuf,
réponses **fabriquées et déclarées telles**, T2), `eslint.config.js` (bloc
`src/convoyeur/**` et frontières du point 1), `test/lint/fixtures/`,
`test/convoyeur/frontiere.test.ts` (neuf).

**Résultat** : un transport à routes **énumérées** — `key_permissions`,
`accounts` (v3, filtré sur *Primary*), `create_market_buy`, `order`,
`move_funds`, `transaction_summary` (U2) — et rien d'autre. Le corps d'achat a
pour type `market_market_ioc: { quote_size: '100' }` : un autre montant ne
compile pas. `moveFunds` refuse, **avant tout appel**, une source autre que
l'UUID de *Primary* ou une destination autre que celle configurée.
`keyPermissions` lit `portfolio_type` et `can_transfer`, qu'il exige présents.

**Validation** : CV4 — le garde-fou d'`eslint` refuse dans `src/convoyeur/**` tout
membre `v2…`, tout accès calculé sur l'instance ccxt, `fetch` et les imports hors
liste du point 1 ; chaque règle a sa fixture de lint qui rougit, et l'arbre réel
passe ; les routes du transport sont énumérées par un test, comme E10. CV2 — une
destination altérée d'un caractère n'atteint pas le transport (le double compte
zéro appel). Un `accounts` qui rend un compte d'un autre portefeuille est refusé,
comme `balanceFrom` d'Ubac. **Mutations** : ajouter une route `send` au
transport — l'énumération rougit ; retirer le contrôle de destination — la sonde
CV2 rougit ; retirer la règle `v2` — sa fixture passe au vert, le test rougit.

**Pièges.** (1) **Le scoping n'est pas une barrière en v2** (constat du
2026-09-11, `docs/cle-coinbase.md`) : c'est pourquoi CV4 interdit la v2 dans le
code, et pourquoi MC2 mesure au lieu de croire. (2) **Ne pas réutiliser
`src/adapters/coinbase.ts`** : ses types interdisent l'ordre au marché, et c'est
voulu ; `decimalFromApi` et le contrôle de portefeuille se recopient, avec le
même commentaire de recopie que `DECIMAL_TEXT`. (3) **`move_funds` ne rend
rien d'utile** (S7) : l'adapter rend « demandé », jamais « fait » ; le fait se
constate par la relecture du solde (Y4b). (4) **`client_order_id` rejoué**
(S5) : la réponse est l'ordre existant, et l'adapter ne doit pas la lire comme un
refus. (5) Les fixtures fabriquées se remplacent par des captures après le
premier convoyage réel (OP6). (6) **`eslint.config.js` est partagé** :
sérialisé avec tout lot qui le touche.

### Y4a — La base du convoyeur : le journal et l'apport, par son seul rôle

**Dépend de** : **Y1** fusionné. · **Critères** : **CV11** (moitié écriture),
**CV12**, **CV14**. · **Audit** : argent → mutation **+** audit complet ;
**`make test-db` obligatoire**. · **Diff estimé compté** : **~450 lignes**.
**Fichiers prévus** : `src/convoyeur/base.ts` (neuf : port `ConvoyeurBase` et
son implémentation Drizzle), `test/convoyeur/base.test.ts` (neuf, base),
`test/convoyeur/doubles.ts` (neuf), `docs/base-de-donnees.md` §6.

**Résultat** : un port de trois opérations — lire le dernier convoyage et son
étape, écrire une étape (`RECORDED` | `ALREADY_RECORDED`), écrire l'apport
(`RECORDED` | `ALREADY_RECORDED`) — dont l'implémentation **se connecte sous le
rôle du convoyeur** dans les tests de base. L'apport a pour origine `CONVOYEUR`,
pour clé `CONVOYEUR:<client_order_id>`, pour montant l'USDC transféré, pour
instant celui du transfert (DC5), et pour note l'EUR débité, les frais et
l'identifiant d'ordre de l'exchange (DC4).

**Validation** : CV11 — deux écritures de même clé laissent une ligne, la seconde
rend `ALREADY_RECORDED` **sous le rôle du convoyeur**, sans `SELECT` ; une 23505
sur une autre contrainte remonte. CV12 — une ligne écrite à T entre deux photos
est relue par `recentCashFlows` d'Ubac, comptée par `netFlow()` dans la
sous-période qui se ferme au run suivant, et l'indice ne monte pas du montant.
CV14 — la même ligne gèle A sept jours par `lastFunding()`. **Mutations** :
traduire toute 23505 en `ALREADY_RECORDED` — la sonde de l'autre contrainte
rougit ; horodater à l'instant de l'écriture — la sonde CV12 à fenêtre étroite
rougit.

**Pièges.** (1) **Aucun `RETURNING`** : il exige `SELECT`, que le rôle n'a pas.
(2) **Les tests de CV12 et CV14 importent `snapshot.ts` et le noyau** : c'est
permis à `test/`, interdit à `src/convoyeur/` (Y3). (3) **La note ne porte aucun
secret** : identifiants d'ordre et montants seulement.

### Y4b — Le passage : reprendre, acheter, transférer, enregistrer

**Dépend de** : **Y2**, **Y3** et **Y4a** fusionnés. · **Décisions** : DC3, DC5,
DC6, DC8. · **Critères** : CV5, CV6 (rejeu), CV7, CV8, CV9, CV10, CV11, CV13 **de
bout en bout** sur doubles. · **Audit** : argent → mutation **+** audit complet. ·
**Diff estimé compté** : **~650 lignes**.
**Fichiers prévus** : `src/convoyeur/passage.ts` (neuf),
`test/convoyeur/passage.test.ts` (neuf), `test/convoyeur/doubles.ts`,
`docs/convoyeur.md` (section « Le passage », créée par Y9 ou ici).

**Résultat** : `passage(ports, config, instant)` lit la clé, puis le journal,
puis les soldes ; reprend le convoyage ouvert selon la table du point 3 ou en
commence un ; écrit l'étape **avant** chaque appel ; relit l'ordre jusqu'à son
remplissage, en tentatives bornées avec une pause **injectée** ; relit le solde
après le transfert ; écrit l'apport ; et rend un compte rendu qui dit l'étape
atteinte, les montants, et si l'invariant DC6 tient. S'il ne tient pas, le compte
rendu est `urgent` et dit quelle étape manque et ce que le run de 07:00 va lire
(CV13).

**Validation** : par des doubles qui **lèvent à chaque frontière** : une panne
après l'achat → le passage suivant transfère sans racheter (le double compte un
seul ordre créé) ; une panne après le transfert → aucun second `move_funds` ;
une panne entre transfert et écriture → écriture au passage suivant, avec
l'instant de `TRANSFERT_DEMANDE` ; un USDC étranger → aucun achat, aucun
transfert, `urgent` ; 250 EUR → trois passages, 100, 100, rien ; un ordre jamais
rempli dans le délai → étape `ACHAT_DEMANDE` laissée, `urgent`, rien de
transféré. CV5 : sous 100 EUR, une ligne de journal et **aucun** compte rendu à
notifier. **Mutations** : écrire l'étape après l'appel — la sonde de panne
pendant l'appel rougit ; transférer le solde relu au lieu de `filled_size` quand
ils diffèrent — la sonde CV10 rougit ; lancer un achat après une reprise — la
sonde « finir ou commencer » rougit.

**Pièges.** (1) **Aucune horloge** : l'instant du passage entre en paramètre ; les
instants des étapes aussi, par une horloge injectée, jamais `Date.now()` —
`src/convoyeur/` reçoit les règles de pureté de `src/jobs/` (Y3). (2) **La
reprise « dans le même passage »** (DC6) : une erreur d'exchange transitoire se
retente dans le passage, en nombre borné ; au-delà, `EN_PANNE` et `urgent`,
environ douze heures avant le run (H2). (3) **Le délai du job** borne la somme
des tentatives : il se fixe dans la définition (OP4) et se cite ici. (4) **Un
second lancement le même jour** bute sur l'index du jour de convoyage : il finit
ce qui est ouvert, ne commence rien, et le dit.

**Redécoupe** : **Y4b1** l'achat et le transfert ; **Y4b2** la reprise et CV13.

### Y5 — Le point d'entrée, la configuration, le `DRY_RUN` et ntfy

**Dépend de** : **Y4b** fusionné ; **Y3** pour `eslint.config.js`. ·
**Décisions** : Q2, Q7, DP4, et la notification ntfy sans email. ·
**Critères** : **CV16**, **CV17** ; CV1 clos (« sans rien faire d'autre », au
démarrage) ; CV3, moitié code. · **Audit** : garde-fou + secret → mutation **+**
audit complet. · **Diff estimé compté** : **~650 lignes**.
**Fichiers prévus** : `src/convoyeur/main.ts` (neuf, seul point de composition),
`src/convoyeur/env.ts` (neuf, seul lecteur de l'environnement de l'arbre),
`src/convoyeur/inertes.ts` (neuf), `src/convoyeur/ntfy.ts` (neuf, sur
`HttpSend`), `test/convoyeur/main.test.ts`, `test/convoyeur/env.test.ts`,
`test/convoyeur/frontiere.test.ts`, `package.json` (script de poste
`convoyeur`, comme `daily`), `eslint.config.js` (lecture de l'environnement
réservée à `env.ts`).

**Résultat** : `node dist/convoyeur/main.js --at=<instant> --git-sha=<sha>
[--reel]`. **Sans `--reel`, c'est un `DRY_RUN`** : l'exchange est lu, les
écritures (ordre, `move_funds`, base) passent par des ports inertes qui
journalisent ce qu'ils auraient fait. Les variables sont préfixées
`CONVOYEUR_` : `CONVOYEUR_DATABASE_URL`, `CONVOYEUR_COINBASE_API_KEY`,
`CONVOYEUR_COINBASE_API_SECRET`, `CONVOYEUR_PRIMARY_UUID`,
`CONVOYEUR_DESTINATION_UUID`, `CONVOYEUR_NTFY_URL`, `CONVOYEUR_NTFY_TOPIC`,
`CONVOYEUR_NTFY_TOKEN`. Chaque passage qui agit pousse une notification
préfixée « convoyeur » en réel, « convoyeur DRY_RUN » sinon (DP4 = 1). **Le mode
est dit partout** (DP5 = 2) : première ligne du journal de chaque passage
(`mode=DRY_RUN` ou `mode=REEL`), titre de chaque notification, et un argument
inconnu (`--real`, `--reel=oui`) fait refuser le démarrage plutôt que retomber en
silence sur le `DRY_RUN`.

**Validation** : CV16 — en `DRY_RUN`, les doubles d'écriture comptent zéro
appel, et le journal dit l'ordre et le transfert qu'il aurait faits ; CV17 — un
convoyage, un refus, une reprise, une panne poussent chacun une notification qui
porte EUR, USDC, frais, étape et EUR laissé ; un passage sans convoyage n'en
pousse aucune ; aucun module d'email n'est importé. CV1 clos — une clé refusée
arrête le passage avant toute lecture de solde. CV3 — le chargeur du convoyeur
ne lit aucune variable d'Ubac et l'inverse, sonde sur les deux listes de noms ;
**la sonde K1 existante** (`test/adapters/coinbase.test.ts`, clé à
`can_transfer: true` refusée par `permissionsFrom`) est citée, pas recopiée.
Le mode figure dans la première ligne du journal et dans le titre de chaque
notification, sonde par mode. **Mutations** : lire `--reel` par défaut à vrai — la sonde CV16 rougit ;
accepter un argument inconnu — sa sonde rougit ;
notifier un passage sans convoyage — sa sonde rougit ; lire `DATABASE_URL`
plutôt que `CONVOYEUR_DATABASE_URL` — la sonde des noms rougit.

**Pièges.** (1) **Le mode ne voyage pas** : lu dans `main.ts`, une fois, il
choisit les ports ; le motif d'A25 s'applique à l'arbre du convoyeur. (2) **Rien
n'importe `main.ts`**, qui lance le passage à l'évaluation — le motif d'A22,
dans un test du convoyeur, **sans toucher `test/jobs/purete.test.ts`** (partagé
avec S11). (3) **Le défaut est le `DRY_RUN`, à l'inverse d'Ubac** : le réel est
un geste de console (DP5 = 2), jamais l'oubli d'un argument. (4) Le canal ntfy est celui d'Ubac,
sous d'autres noms de variables (CV3) : même valeurs, secrets posés deux fois.
(5) **La lecture de la liste des noms d'Ubac** peut demander d'exporter une
constante de `src/config/env.ts` : sérialisé avec S12.

### Y6 — L'image distincte et son point d'entrée

**Dépend de** : **Y5** fusionné. · **Décision** : Q7. · **Critères** : CV3, moitié
images. · **Audit** : garde-fou (l'image de production) → mutation **+** audit
complet. · **Diff estimé compté** : **~450 lignes**.
**Fichiers prévus** : `Dockerfile.prod` (cible `convoyeur`),
`scripts/entrypoint-convoyeur.sh` (neuf), `scripts/build-image.sh` (paramètre de
cible), `scripts/verifier-image.sh` (contrôles des deux images),
`.github/workflows/ci.yml` (job `build` : deux images),
`test/ci/workflow.test.ts`, `docs/deploiement.md` §3 à §6,
`docs/integration-continue.md` §7.

**Résultat** : `build` pousse `…/ubac:<sha>` et `…/ubac-convoyeur:<sha>`.
L'image du convoyeur a pour point d'entrée `ubac-convoyeur`, qui fabrique
`--at` par un seul `date -u` et lance `dist/convoyeur/main.js` ; **elle ne
contient pas `dist/jobs/`**, et l'image d'Ubac **ne contient pas
`dist/convoyeur/`**. `verifier-image.sh` constate les deux, en plus de ses dix
contrôles, pour chaque image.

**Validation** : le point d'entrée d'Ubac est **inchangé à l'octet** ; chaque
image rougit si l'arbre de l'autre y réapparaît ; l'image du convoyeur lancée
sans configuration refuse de démarrer sans réseau ; architecture, SHA embarqué,
absence de `drizzle-kit` et de `tsx` tenus pour les deux. **Mutation** : faire
pointer le point d'entrée du convoyeur sur `daily-main` — le contrôle rougit.

**Pièges.** (1) **Une seule compilation** : le retrait de l'arbre de l'autre se
fait dans l'étape d'image, pas par deux `tsconfig` qui divergeraient. (2) **Le
contrôle « déjà poussée »** de `build` vaut pour chaque référence : un tag sur un
commit déjà construit ne doit réécrire **aucune** des deux. (3) **R4 et R7** de la
phase 2 touchent `ci.yml` et `test/ci/` : sérialisés.

### Y7a — Les contrôles du déploiement, extraits à comportement constant

**Dépend de** : rien ; sérialisé avec Y6 sur `ci.yml` et `test/ci/`. ·
**Décision** : U8 (« ses contrôles ne doivent pas s'affaiblir pour Ubac »). ·
**Critères** : aucun directement ; prépare CV3 (définitions). · **Audit** :
garde-fou → mutation **+** audit complet. · **Diff estimé compté** : **~400
lignes**, surtout des déplacements.
**Fichiers prévus** : `scripts/deploiement/controles.sh`,
`scripts/deploiement/relecture.sh` (neufs, extraits de `ci.yml`),
`.github/workflows/ci.yml`, `test/ci/deploiement.test.ts`,
`test/ci/workflow.test.ts`, `docs/integration-continue.md` §8.

**Résultat** : les étapes « contrôles avant » et « relecture » du job `deploy`
appellent des scripts du dépôt, **paramétrés par leur environnement** comme
aujourd'hui (`DECLENCHEUR`, `VARIABLES`, `CPU_MVCPU`…) ; les sondes de
`deploiement.test.ts` exécutent ces scripts au lieu d'extraire le YAML, et
**passent sans retouche de leurs attentes**.

**Validation** : toutes les sondes existantes restent vertes avec des attentes
identiques ; `workflow.test.ts` constate que `ci.yml` appelle les scripts avec
les valeurs d'Ubac épinglées. **Mutation** : changer `FENETRE_MIN` dans l'appel
— la sonde de fenêtre rougit.

**Piège.** **C'est un lot sans nouveau comportement, et cela ne rougit nulle
part** si l'extraction est fidèle ; la preuve est que les attentes des sondes
n'ont pas bougé d'un caractère — le diff des tests ne touche que le chargement.

**Pourquoi Y7a reste séparé d'Y7b** (revue du plan) : fusionnés, ils feraient
~950 lignes comptées — au-dessus de la cible de 700 et à 5 % du plafond, sur une
frontière dont l'étalon prévoit un débordement de 1,5 à 2 (les ~110 lignes de
contrôles et de relecture du job `deploy` s'extraient, et `workflow.test.ts`,
1 129 lignes, suit) — alors que séparé, Y7a garde une preuve que la fusion
noierait : des attentes de sonde inchangées au caractère près.

### Y7b — Le job `deploy` à deux définitions

**Dépend de** : **Y6** et **Y7a** fusionnés ; OP4 fait avant le premier tag qui
le contient. · **Décisions** : Q7, U8, DP5 = 2. · **Critères** : CV3, moitié
définitions ; CV23, moitié visibilité (le mode lu et rapporté). · **Audit** : garde-fou +
secret → mutation **+** audit complet. · **Diff estimé compté** : **~550
lignes**.
**Fichiers prévus** : `.github/workflows/ci.yml` (job `deploy-convoyeur`),
`scripts/deploiement/controles.sh`, `test/ci/deploiement.test.ts`,
`test/ci/workflow.test.ts`, `docs/integration-continue.md` §8,
`docs/deploiement.md` §8.

**Résultat** : un second job, `deploy-convoyeur`, qui **suit** `deploy`
(`needs`) et repointe la définition `SCW_CONVOYEUR_JOB_DEFINITION_ID` sur
l'image du convoyeur, avec les mêmes contrôles avant et la même relecture, ses
propres valeurs épinglées : un seul déclencheur nommé `convoyeur`, les variables
`CONVOYEUR_*`. **Le mode n'est pas épinglé** (DP5 = 2) : il est **lu** dans les
arguments du déclencheur, écrit dans le journal et le résumé du déploiement
(« mode du convoyeur : DRY_RUN » ou « REEL »), et la relecture constate qu'il n'a
pas changé pendant le déploiement ; aucun mode ne fait refuser un déploiement.
Les contrôles d'Ubac
gagnent une règle et n'en perdent aucune : **aucune variable `CONVOYEUR_*`** sur
sa définition ; ceux du convoyeur refusent toute variable d'Ubac.

**Validation** : la définition d'Ubac telle qu'elle tourne passe, avec une
variable `CONVOYEUR_*` ajoutée elle est refusée (CV3) ; la définition du
convoyeur passe avec `[]` comme avec `["--reel"]`, et le résumé dit
respectivement `DRY_RUN` et `REEL` ; un échec de `deploy` n'atteint pas `deploy-convoyeur` ; la relecture
du convoyeur compare aussi les arguments du déclencheur, et un mode changé
pendant le déploiement est un écart de relecture. **Mutations** : retirer
`needs: deploy` — la sonde d'ordre rougit ; ne plus écrire le mode au résumé —
sa sonde rougit ; relâcher le déclencheur unique
d'Ubac — sa sonde, inchangée depuis R3, rougit.

**Pièges.** (1) **La fenêtre de 15 minutes** se lit dans chaque déclencheur :
celle du convoyeur entoure 19:00 Europe/Paris, celle d'Ubac 07:00 ; un tag posé
à 18:50 déploie Ubac et refuse le convoyeur, ce qui est voulu. (2) **Le groupe de
concurrence** : un seul déploiement à la fois, les deux jobs dans le même tag.
(3) **Sans OP4, le premier tag échoue** sur « variable de forge absente » après
avoir déployé Ubac : le dire dans la PR, et poser la variable avant le tag.
(4) **Le premier déploiement du convoyeur n'attend pas ce lot** : OP4 crée la
définition sur l'image que `build` a poussée (Y6) ; Y7b ne sert qu'aux tags
suivants — c'est le repli si Y7b n'est pas fusionné en octobre.

### Y8 — CV15 : une divergence entièrement expliquée par les flux ne crie plus

**Dépend de** : **S13** fusionné, strictement et sans repli (point 4) ; **DP1**
tranchée. **Reprend** : N10
du plan des flux, réduit. · **Décisions** : Q4 = 1, D4 des flux, T6. ·
**Critères** : **CV15**. · **Audit** : garde-fou (une alerte urgente se tait) →
mutation **+** audit complet ; **`make test-db` obligatoire** si la lecture des
flux change de requête. · **Diff estimé compté** : **~600 lignes**.
**Fichiers prévus** : `src/jobs/reconcile.ts`, `src/jobs/snapshot.ts` (exporter
le prédicat de fenêtre de `netFlow`), `src/jobs/alerts.ts`, `src/jobs/daily.ts`,
`src/report/daily-report.ts`, `src/report/lexique.ts`,
`test/jobs/reconcile.test.ts`, `test/jobs/alerts.test.ts`,
`test/jobs/daily.test.ts`, `test/report/daily-report.test.ts`,
`test/report/contrat-run.test-d.ts`, `docs/reconciliation.md` §3 bis et §6,
`docs/alertes.md`.

**Résultat** : la réconciliation qualifie chaque divergence : la ligne USDC est
**expliquée** si, flux de `]photo, run]` ajoutés au cache, elle ne diverge plus
(DP1 = 1) ; BTC, ETH et toute autre devise ne le sont jamais. Quand **toutes**
les divergences sont expliquées, `RECONCILIATION_DRIFT` ne part pas ; le cache
se resynchronise, `ETAT_RESYNCHRONISE` marque les quatre décisions, E60 refuse
d'exécuter, et **le rapport le dit** : état resynchronisé, apport qui l'explique,
aucun ordre placé ce jour.

**Validation** : CV15 — un apport de 7 % de la ligne USDC, enregistré par une
ligne `CONVOYEUR`, qui pousse `RECONCILIATION_DRIFT` sur `main`, n'en pousse plus
(sonde écrite d'abord rouge sur `main`) ; même apport à moitié enregistré → crie ;
divergence USDC expliquée et BTC non → crie ; le marqueur est sur les quatre
décisions et aucun ordre n'est placé. **Mutations** : taire dès qu'**une** ligne
est expliquée — la sonde mixte rougit ; lire les flux en `>=` sur la borne basse
— la sonde du flux de la veille rougit ; retirer la phrase d'E60 du rapport — sa
sonde rougit.

**Pièges.** (1) **Une fenêtre, un prédicat** : exporté de `snapshot.ts`, jamais
recopié. (2) **Une lecture des flux, pas deux** : si la réconciliation les lit
elle-même, `daily.ts` lit la même fenêtre pour le chaînage ; les faire partager
une lecture change le contrat de `reconcile`, ce que le lot dit et sonde. (3) **La
phrase d'E60 déménage** (T6) : ces jours-là, `RECONCILIATION_DRIFT` se tait, et
seul le rapport dit que rien n'est parti. (4) **Le contrat du rapport lisait peu
`resync`** : `resync` quitte `NonLusAttendus` si le rapport le lit désormais,
et `MemeEnsemble` fait échouer `tsc` sinon. (5) **Le lendemain d'une exécution**
(G3) reste hors du lot : une divergence mêlant apport et exécution n'est pas
entièrement expliquée et crie. (6) **E39 ne bouge pas** : même base, même seuil ;
`reconcile-accord-risque.test.ts` reste vert sans retouche. (7) `daily.ts`,
`alerts.ts` et `reconcile.ts` sont dans la file de S9, S12, S13 et S14.

### Y9 — La documentation de l'opérateur

**Dépend de** : rien ; les noms de variables sont ceux d'Y5, fixés ici. ·
**Critères** : **CV18**. · **Audit** : mutation seule — aucun code, aucun
secret. · **Diff estimé compté** : **~400 lignes**.
**Fichiers prévus** : `docs/convoyeur.md` (neuf), `docs/cle-coinbase.md` (renvoi,
et la clé du convoyeur à côté de celle d'Ubac), `docs/deploiement.md` §1
(variables du convoyeur).

**Résultat** : sur le modèle de `docs/cle-coinbase.md`, la création de la clé
(*Primary*, `view` + `trade` + `transfer`, **jamais sur `ubac-agent`**),
l'activation de la liste blanche **vide** et ses délais de 48 h (S11), le rôle
Neon et son mot de passe posé à la main, les secrets `CONVOYEUR_*` dans Scaleway
**seulement**, le calendrier d'octobre (point 6), le geste de reprise après une
alerte `urgent`, et ce que la clé peut faire au pire (S9, D3, DC8). Les sources
S7 à S13 sont citées.

**Validation** : chaque commande citée existe ; chaque renvoi pointe vers une
section qui existe ; aucune valeur de clé, d'UUID réel ni de mot de passe.
**Piège** : **la clé d'Ubac garde `can_transfer=false`** — la doc le redit à
l'endroit où l'on coche `transfer`, parce que c'est là qu'on se trompe de clé.

### Y10 — L'outil des mesures MC1 à MC3

**Dépend de** : rien. · **Décision** : DP2 = 1. · **Critères** : prépare CV20, CV21,
CV22. · **Audit** : argent + secret → mutation **+** audit complet. · **Diff
estimé compté** : **~350 lignes**.
**Fichiers prévus** : `scripts/mesures-convoyeur.ts` (neuf, **hors `src/`**,
donc hors de toute image), `test/scripts/mesures-convoyeur.test.ts` (sur
transport simulé), `docs/convoyeur-mesures.md` (neuf).

**Résultat** : une commande de poste, lancée **par l'opérateur** via
`./scripts/dev.sh npx tsx scripts/mesures-convoyeur.ts <mesure>`, qui lit la clé
dans un fichier **hors dépôt** passé en argument, exige une confirmation par
mesure, fait **une** requête par mesure au montant minimal, et imprime le code
HTTP, le message d'erreur de l'exchange et les soldes avant / après — **jamais
un en-tête, un jeton ni la clé**. Trois mesures : `mc1` (`move_funds` de
`ubac-agent` vers *Primary*, 1 USDC), `mc2-crypto` (envoi v2 de 1 USDC depuis
*Primary* vers une adresse **de l'opérateur**, hors carnet), `mc2-eur` (retrait
EUR v2 vers le compte bancaire **de l'opérateur**), `mc3` (`move_funds` de 1 USDC
de *Primary* vers `ubac-agent`).

**Validation** : sur transport simulé, chaque mesure fait exactement une requête
et n'en fait aucune sans confirmation ; la sortie ne contient ni la clé ni un
jeton (sonde sur une clé piégée) ; le script n'est pas dans l'image (constat
d'Y6). **Mutation** : boucler sur la mesure en cas d'échec — la sonde « une
requête » rougit.

**Pièges.** (1) **CV4 ne vise que `src/convoyeur/`** : ce script est la seule
place du dépôt où la v2 d'envoi est écrite, et la doc dit pourquoi. (2) **Un refus
pour solde insuffisant ne prouve rien** : chaque mesure vérifie d'abord que la
source porte le montant, sinon elle ne part pas. (3) **Le destinataire est
toujours l'opérateur** : un envoi qui réussit est une mauvaise nouvelle, pas une
perte.

## Étapes de l'opérateur

Aucune ne se dispatche à un agent : elles demandent la clé du convoyeur, la
console Coinbase, la console Scaleway ou Neon. **Aucune clé, aucun mot de passe,
aucune chaîne de connexion ne passe par Orca** ; on y rapporte des constats.

| # | Quand | Qui | Quoi | Ce qui est rapporté dans Orca |
|---|---|---|---|---|
| **OP1** | dès Y9 fusionné, **au plus tard le 2026-10-09** (délais de 48 h) | opérateur, console CDP | créer la clé sur *Primary*, `view` + `trade` + `transfer` ; activer la liste blanche vide ; ranger la clé dans un fichier hors dépôt, `chmod 600` | la ligne `key_permissions` (portefeuille, type, `can_*`), sans la clé ; l'état de la liste blanche |
| **OP2** | après OP1 et Y10, **avant OP4** (DP3 = 1) | opérateur, poste | MC1, MC2 (crypto et EUR), MC3 avec `scripts/mesures-convoyeur.ts`, **entre deux runs d'Ubac**, loin de 07:00 : MC1 puis MC3 laissent `ubac-agent` à net nul | **CV20** : code et message de MC1 ; **CV21** : code et message de l'envoi crypto, et du retrait EUR, quel qu'il soit ; **CV22** : réponse de MC3 et solde relu ; soldes avant / après de chaque mesure |
| **OP3** | après Y1, **avant tout tag qui contient Y4a** | opérateur, poste | compter `cash_flows` ; `db:push` sur Neon avec TTY ; rejouer `scripts/role-convoyeur.sql` ; poser le mot de passe du rôle par `\password` | le compte de lignes avant et après, et leur origine ; **avant le script**, ce que `PUBLIC` tient sur la base, le schéma `public`, ses tables, séquences et fonctions (`aclexplode`), et le propriétaire des tables ; **après**, `pg_has_role(…, 'neon_superuser', 'member') = false`, `has_schema_privilege('ubac_convoyeur', 'public', 'CREATE') = false`, `has_database_privilege('ubac_convoyeur', <base>, 'TEMP') = false`, `has_table_privilege` du rôle sur chaque table (`true` seulement pour `INSERT` sur `cash_flows`, `SELECT` / `INSERT` sur le journal ; `false` pour `SELECT` sur `decisions`, table non autorisée), `has_sequence_privilege` et `has_function_privilege` à `false` sur tout le schéma ; le rôle d'Ubac inchangé (mêmes `has_table_privilege` avant et après) |
| **OP4** | après Y6, OP3 et **OP2** (DP3 = 1) | opérateur, console Scaleway | créer la définition `ubac-convoyeur` : image de `build`, délai et ressources d'Y4b, **aucune tentative**, déclencheur `convoyeur` `0 19 * * *` Europe/Paris **sans argument**, secrets `CONVOYEUR_*` ; variable de forge `SCW_CONVOYEUR_JOB_DEFINITION_ID` | l'identifiant de définition ; la liste des noms de variables, sans valeurs ; le journal du premier passage |
| **OP5** | virement du ~2026-10-27 | opérateur | attendre la notification « convoyeur DRY_RUN » du passage de 19:00 ; **puis** convertir dans *Primary*, transférer, saisir `cash_flows` comme aujourd'hui, **avant 07:00** | **CV23** : les lignes du journal du passage (ordre et transfert qu'il aurait faits) ; le constat que rien n'a bougé ; le rapport d'Ubac du lendemain |
| **OP6** | après **Y7b**, **Y8** et **S13** fusionnés et déployés, **CV20 à CV22 rapportés et favorables**, OP5 constaté ; avant le virement de novembre | opérateur, console Scaleway | ajouter `--reel` aux arguments du déclencheur `convoyeur` (DP5 = 2) ; aucune PR | **CV23** : le message Orca cite les rapports MC1 à MC3, OP5 et les fusions de S13 et Y8 ; le journal du premier passage qui dit `mode=REEL` ; puis le premier convoyage réel : ordre, `filled_size`, frais (U2, lus par `transaction_summary`), ligne `cash_flows`, rapport d'Ubac du lendemain sans `RECONCILIATION_DRIFT` ; captures pour remplacer les fixtures fabriquées d'Y3 |

**OP6 ne se fait pas si MC1 ou MC2 échoue** : la décision revient à
l'opérateur par Orca (spec, fin des critères). Le prochain tag après OP6 dit
`REEL` dans le résumé de `deploy-convoyeur` : c'est la trace durable du geste,
hors de `git`.

**Si MC1 ou MC2 échoue**, OP4 n'a pas lieu avec cette clé (DP3 = 1), la clé est
révoquée, et la suite revient à l'opérateur par une décision Orca.

## Couverture des critères CV1 à CV23

Exhaustive. Un critère partagé entre deux lots est **clos après le dernier**.

| Critère | Lot | Note |
|---|---|---|
| CV1 | **Y2** (règle), **Y3** (lecture de `portfolio_type`, `can_transfer`), **Y5** (au démarrage, rien d'autre) | clos après Y5 |
| CV2 | **Y2** (règle), **Y3** (refus avant appel) | clos après Y3 |
| CV3 | **Y5** (noms, sonde K1 citée), **Y6** (images et points d'entrée), **Y7b** (définitions réelles) | clos après Y7b ; OP4 le constate |
| CV4 | **Y3** | garde-fou `eslint` sur `src/convoyeur/**` ; Y10 est hors de son champ, et le dit |
| CV5 | **Y2**, **Y4b** | aucune notification : Y5 |
| CV6 | **Y2** (identifiant), **Y3** (`quote_size: '100'` par le type), **Y4b** (rejeu) | |
| CV7 | **Y2** (propriété), **Y4b** (trois passages) | surplus chiffré dans la notification : Y5 |
| CV8 | **Y2**, **Y4b** | |
| CV9 | **Y2** (table), **Y4b** (pannes à chaque frontière) | |
| CV10 | **Y2**, **Y4b** | |
| CV11 | **Y1** (clé, index), **Y4a** (écriture sous le rôle), **Y4b** (une ligne par transfert) | `make test-db` |
| CV12 | **Y4a** | sonde de base, lecture d'Ubac |
| CV13 | **Y2** (texte), **Y4b** (alerte), **Y5** (envoi) | |
| CV14 | **Y4a** | noyau inchangé |
| CV15 | **Y8** | strictement après **S13** fusionné ; DP1. S13 qui glisse fait glisser OP6, pas Y8 |
| CV16 | **Y5** | |
| CV17 | **Y2** (textes), **Y5** (envoi, aucun email) | DP4 pour le `DRY_RUN` |
| CV18 | **Y9** | |
| CV19 | **Y1** | contre la base locale ; OP3 le constate sur Neon |
| CV20, CV21, CV22 | **OP2**, outil **Y10** | mesurés et rapportés par l'opérateur |
| CV23 | **OP5** (`DRY_RUN` d'octobre), **Y5** et **Y7b** (mode dit et rapporté), **OP6** (réel) | clos après OP6 |

## Ordre, vagues et sérialisation

Le chemin critique d'octobre est **Y1 → Y4a → Y4b → Y5 → Y6 → OP4** ; Y2 et Y3
le rejoignent en Y4b. Y7b n'y est pas (OP4 crée la définition) ; Y8 et OP6 sont
sur le chemin de novembre, avec S13.

| Vague | Lots | Workers | Ce qui les sépare |
|---|---|---|---|
| **1** | **Y1**, **Y2**, **Y3** | **3** | schéma + `db.ts` + SQL / `src/convoyeur/regles.ts` neuf / `src/convoyeur/coinbase.ts` + `eslint.config.js` |
| **2** | **Y4a**, **Y9**, **Y10** | **3** | `src/convoyeur/base.ts` / `docs/convoyeur.md` / `scripts/mesures-convoyeur.ts` |
| **3** | **Y4b**, **Y7a** | 2 | `src/convoyeur/passage.ts` / `scripts/deploiement/` + `ci.yml` + `test/ci/` |
| **4** | **Y5** | 1 | `main.ts`, `env.ts`, `eslint.config.js`, `package.json` |
| **5** | **Y6** | 1 | `Dockerfile.prod`, scripts d'image, `ci.yml` |
| **6** | **Y7b** | 1 | `ci.yml`, `test/ci/` |
| **hors vague** | **Y8** | 1 | strictement après **S13** fusionné, jamais avant ; file de `daily.ts` avec S9 et S13 |

Les vagues 3 à 6 laissent un ou deux workers libres. **S13 y est prioritaire** :
il prend le premier worker libre de la vague 3, avant S9 et S12, qui se placent
ensuite sous la table ci-dessous (S9 et S13 se sérialisent sur `daily.ts`).

**Calendrier cible.** Vagues 1 à 5 et OP1, OP3 fusionnés ou faits **avant le
2026-10-23** ; OP2 et OP4 le **2026-10-24** au plus tard ; tag et quelques
passages « rien à faire » avant le 27. S13 fusionné **au plus tard le
2026-11-13**, puis Y8, puis OP6 **avant le 2026-11-24**, pour le virement de
novembre. **Si S13 glisse au-delà du 2026-11-13, la conséquence est le report
d'OP6** au virement suivant — le convoyeur reste en `DRY_RUN` et l'opérateur
convoie à la main comme en octobre (OP5) — **pas un Y8 anticipé** (point 4,
U6).

**Volume estimé : ~6 450 lignes** en douze lots (Y1 passe de ~600 à ~650 avec le
retrait de `PUBLIC` ; Y7a reste séparé d'Y7b, voir Y7a), déjà corrigées du facteur
constaté ; les fixtures de réponse d'Y3 sont écrites à la main et comptées ;
aucun lockfile ni fichier généré attendu.

**Fichiers à sérialiser**, même sans dépendance métier :

| Fichier | Lots de ce plan | Aussi touché par |
|---|---|---|
| `src/adapters/schema.ts`, `src/adapters/db.ts`, `test/adapters/db.test.ts` | Y1 | S9 ; N3, N6, N8 (suite) |
| `eslint.config.js`, `test/lint/fixtures/` | Y3, Y5 | S11 si la sortie y gagne une règle |
| `package.json` | Y5 | S11b (script de sortie) |
| `src/config/env.ts` | Y5 (si une constante s'exporte) | S12 |
| `.github/workflows/ci.yml`, `test/ci/workflow.test.ts` | Y6, Y7a, Y7b | R4, R7 |
| `test/ci/deploiement.test.ts` | Y7a, Y7b | R4 |
| `Dockerfile.prod`, `scripts/build-image.sh`, `scripts/verifier-image.sh` | Y6 | S11b, N4 (suite) |
| `src/jobs/daily.ts`, `src/jobs/alerts.ts` | Y8 | S9, S12, S13 |
| `src/jobs/reconcile.ts`, `src/jobs/snapshot.ts` | Y8 | N1, N5 (suite) |
| `src/report/daily-report.ts`, `lexique.ts`, `test/report/contrat-run.test-d.ts` | Y8 | S14 |
| `docs/deploiement.md` | Y1, Y6, Y7b, Y9 | R4, R7 |
| `docs/integration-continue.md` | Y6, Y7a, Y7b | R4, R7 |
| `docs/base-de-donnees.md` | Y1, Y4a | — |
| `docs/reconciliation.md`, `docs/alertes.md` | Y8 | S13, S14 |
| `docs/convoyeur.md` | Y4b, Y5, Y9 | — |

## Suite optionnelle : le reste du plan des flux

Non replanifiée ici. Le plan `docs/plans/ubac-flux-non-enregistres.md` (branche
`olaurendeau/ubac-flux-cadrage`) reste l'hypothèse de départ, à revoir contre ce
qui aura été livré : **N1** (devise égarée), **N3, N4** (saisie des retraits),
**N5 à N8** (détection, filet de U9), **N9** (origine au rapport ; les retraits y sont depuis #76),
**N10**, part « flux détecté ». Ses questions **G1 à G4** et sa mesure **M1** ne
se posent qu'avec eux. Rien de ce plan ne les bloque, et Y1 leur donne le schéma.

## Ce que ce plan ne garantira pas

À écrire dans la documentation plutôt qu'à laisser croire ; chaque lot concerné
le déclare à sa livraison.

- **La panne muette (U9)** : un conteneur tué entre le transfert et l'écriture
  n'est vu qu'au passage suivant, après un run d'Ubac ; l'apport y est lu comme
  une performance, définitivement. Le journal le rend visible, pas réparable.
- **Un convoyeur qui ne tourne pas ne le dit à personne** : aucun healthcheck
  n'est prévu par la spec. L'EUR reste dans *Primary* et le passage suivant le
  convoie ; seule l'absence de notification le trahit.
- **La surface est énumérée, pas prouvée** : CV4 interdit d'écrire la v2 dans
  `src/convoyeur/`, il ne prouve pas qu'un client HTTP générique ne peut pas la
  fabriquer. La barrière est la clé, bornée par *Primary* (S9), la liste blanche
  et DC8 ; MC1 et MC2 la mesurent une fois, pas pour toujours.
- **Les droits du rôle ne sont pas dans le schéma** : un `push` qui recrée une
  table les efface, et seule la discipline d'OP3 les rétablit.
- **Les fixtures de l'adapter sont fabriquées** jusqu'au premier convoyage réel.
- **L'index unique de la clé naturelle et les droits du rôle ne sont pas
  couverts par la chaîne** (D2 de la phase 2) : `make test-db` sur le poste est
  ce qui les tient.
- **Le passage au réel n'est pas relu dans `git`** (DP5 = 2) : il est dit à
  chaque passage, à chaque notification et à chaque déploiement, et rapporté
  dans Orca, mais rien ne l'empêche avant les mesures sinon la discipline d'OP6.
- **Le lendemain d'une exécution crie toujours** (G3) ; un apport qui tombe ce
  jour-là crie avec lui.
