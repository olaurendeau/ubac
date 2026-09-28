# Le convoyeur : l'apport mensuel, du Primary au portefeuille d'Ubac

Cadrage du 2026-09-28. Agent **distinct** d'Ubac. Complète le §4
(`cash_flows`) et le §7 (clé Coinbase) de `docs/specs/ubac-rebalance.md` sans
les modifier : la clé d'Ubac reste sans permission de sortie. Recoupe la spec
non fusionnée `docs/specs/ubac-flux-non-enregistres.md` (branche
`olaurendeau/ubac-flux-cadrage`) ; la section « Effet sur le plan des flux »
dit ce qui change.

> **Statut des décisions : closes le 2026-09-28.** Dix questions posées en deux
> passes par Orca (`msg_d8c3e9cbd5a9`, `msg_f3a72b2ade75`), dix réponses de
> l'opérateur. Q3 a reçu la réponse 3 (« exactement 100 EUR »), précisée en Q6.

## Besoin

Chaque mois, vers le 27, un virement SEPA de 100 EUR arrive sur le portefeuille
Coinbase *Primary*. L'opérateur doit aujourd'hui, à la main, le virer vers
`ubac-agent`, le convertir en USDC, puis dicter le montant pour qu'il entre dans
`cash_flows`. Un agent « tout bête », le **convoyeur**, fait ces trois gestes
seul : conversion, transfert, enregistrement de l'apport.

## Ce que le dépôt fait aujourd'hui (relu le 2026-09-28)

- **K1. La clé d'Ubac ne peut pas être celle du convoyeur.** `permissionsFrom`
  (`src/adapters/coinbase.ts`) refuse toute clé dont `can_transfer` n'est pas le
  booléen `false`, exige que le champ soit présent, et refuse une clé scopée
  ailleurs que sur `COINBASE_PORTFOLIO_UUID`. Une clé du convoyeur posée par
  erreur dans le job d'Ubac arrête le run avant toute lecture. D2 est donc déjà
  constatable côté Ubac.
- **K2. `cash_flows` ne sait pas recevoir une écriture automatique.** La table
  (`src/adapters/schema.ts`) n'a que `id` (uuid aléatoire), `occurred_at`,
  `amount_usdc` et `note` : ni origine, ni clé naturelle. Une écriture rejouée
  écrirait deux lignes. C'est le constat K3 de la spec des flux, et le lot N2 de
  son plan.
- **K3. La fenêtre d'un flux est faite d'instants.** `netFlow()`
  (`src/jobs/snapshot.ts`) retient `photo précédente < occurred_at <= instant du
  run`. Un flux horodaté à l'instant réel du transfert tombe dans la bonne
  sous-période **quelle que soit l'heure**, pourvu qu'il soit écrit avant le run
  suivant. Écrit après, il est perdu pour toujours (K2 des flux) ou lu comme une
  fausse perte.
- **K4. Tout apport gèle le déclencheur A sept jours.** `lastFunding()`
  (`src/core/strategy/rebalance.ts`) retient le dernier flux positif, sans seuil ;
  `newCashFreezeDays` vaut 7. En production `ratioBandEnabled` est faux
  (`src/core/config.ts`) : A est le seul déclencheur, gelé environ 7 jours sur 30.
- **K5. Un apport enregistré crie quand même.** `divergencesOf()`
  (`src/jobs/reconcile.ts`) compare ligne à ligne au seuil de 1 % sans soustraire
  les flux connus : 115 USDC sur une ligne USDC de ~1 620 font ~7 %, d'où
  resynchronisation et `RECONCILIATION_DRIFT` en `urgent` le lendemain de chaque
  apport (K6 des flux). Une fois S13 livré, ce jour-là n'exécute pas (E60) ; A
  étant gelé (K4), cela ne coûte rien.
- **K6. Le geste manuel actuel laisse de l'EUR dans `ubac-agent`.** Converti dans
  `ubac-agent`, l'EUR transitoire diverge à 100 % contre la photo (K4 des flux).
  Converti dans le *Primary*, rien d'étranger n'entre dans `ubac-agent`.
- **K7. Le déploiement ne connaît qu'un job.** Le job `deploy` de
  `.github/workflows/ci.yml` met à jour **une** définition Scaleway et refuse un
  déclencheur autre que `daily`. L'image a pour point d'entrée
  `scripts/entrypoint-job.sh`, qui lance `daily-main.js`. La question M1 du plan
  des flux (une surcharge de commande Scaleway remplace-t-elle l'entrypoint ?)
  n'est pas mesurée.
- **K8. Le rapport montre déjà les apports.** La section « Derniers apports »
  (#73) lit les trois dernières lignes positives de `cash_flows`, note comprise :
  l'apport du convoyeur y apparaîtra sans rien toucher au rapport.

## Ce que dit la documentation officielle (vérifiée le 2026-09-28)

| # | Fait | Source | Confiance |
|---|---|---|---|
| S1 | **Convert ne fait pas EUR → USDC** : « applicable for USDC-USD, PYUSD-USD, EURC-EUR conversion, and PYUSD-USDC ». La conversion passe par un ordre `BUY` sur le carnet **USDC-EUR** | [create-convert-quote](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/convert/create-convert-quote), [FAQ Advanced Trade](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/faq) | haute |
| S2 | Le produit **USDC-EUR est en ligne** : `status: online`, `trading_disabled: false`, `base_min_size: 0.01` | endpoint public `GET /api/v3/brokerage/market/products/USDC-EUR` | haute (accès retail FR : moyenne) |
| S3 | **MiCA n'atteint pas l'USDC** : « USDC and EURC are MiCA-compliant and will continue to be supported » | [mica-restricted-stablecoins](https://help.coinbase.com/en/coinbase/other-topics/other/mica-restricted-stablecoins) | haute |
| S4 | Frais : modèle maker / taker au volume sur 30 jours ; premier palier annoncé 0,40 % maker / 0,60 % taker. Le taux réel de la clé se lit par `transaction_summary` | [advanced-trade-fees](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/advanced-trade-fees), [get-transaction-summary](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/fees/get-transaction-summary) | moyenne |
| S5 | `client_order_id` est idempotent : « If the ID provided is not unique, the order will not be created and the order corresponding with that ID will be returned instead » | [create-order](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/create-order) | haute |
| S6 | L'USDC reçu se lit sur l'ordre : `filled_size` (base, donc USDC), `filled_value` (EUR), `total_fees` | [get-order](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/orders/get-order) | haute |
| S7 | `move_funds` : permission **`transfer`** ; corps `funds {value, currency}`, `source_portfolio_uuid`, `target_portfolio_uuid` ; la réponse ne rend que les deux UUID, **aucun identifiant de transfert, aucune clé d'idempotence** | [move-portfolios-funds](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/portfolios/move-portfolios-funds) | haute |
| S8 | Transfert entre portefeuilles « instantaneous and free » | [guide portfolios](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/portfolios), [multiple-portfolios](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/multiple-portfolios) | haute |
| S9 | Un dépôt arrive toujours dans *Primary* ; « You can't withdraw or send funds from Portfolios yet » : seul *Primary* envoie ou retire | [multiple-portfolios](https://help.coinbase.com/en/coinbase/trading-and-funding/advanced-trade/multiple-portfolios) | haute |
| S10 | **`transfer` est décrit de deux façons incompatibles** : « moves between your portfolios only and does not allow withdrawals to external addresses » (page MCP) ; « send and receive funds, on and off platform » (page Coinbase App) ; `key_permissions` le nomme « deposit/withdrawal permissions » | [coinbase-mcp](https://docs.cdp.coinbase.com/ai-agents/coinbase-for-agents/coinbase-mcp), [authorization](https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/authorization), [get-api-key-permissions](https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/rest-api/data-api/get-api-key-permissions) | haute sur la contradiction |
| S11 | Liste blanche d'adresses : limite les envois aux adresses du carnet ; une adresse ajoutée n'est utilisable qu'après 48 h ; la désactiver prend 48 h. **Muette** sur les envois par API, sur une liste vide et sur les retraits EUR | [address-book-allowlist](https://help.coinbase.com/en/coinbase/managing-my-account/other/address-book-allowlist) | haute sur ce qui est écrit |
| S12 | Une clé CDP accepte une liste blanche d'IP ou de CIDR | [security-best-practices](https://docs.cdp.coinbase.com/get-started/authentication/security-best-practices) | haute |
| S13 | **Les Jobs Scaleway n'ont pas d'IP de sortie fixe** (« Dedicated IP — Not available ») : la restriction IP de S12 est inapplicable | [jobs FAQ](https://www.scaleway.com/en/docs/serverless-jobs/faq/), [jobs-limitations](https://www.scaleway.com/en/docs/serverless-jobs/reference-content/jobs-limitations/) | haute (pages de 2025) |
| S14 | SEPA : 1 à 3 jours ouvrés. L'instant où l'EUR devient négociable n'est pas documenté pour un virement | [funding-your-account-emea](https://help.coinbase.com/en/coinbase/trading-and-funding/depositing-or-withdrawing-fiat-money/funding-your-account-emea) | haute / basse |

Deux conséquences structurent tout le cadrage. **S10** : on prend la lecture la
plus défavorable, comme `docs/cle-coinbase.md` l'a toujours fait — une clé
`transfer` scopée sur *Primary* peut peut-être envoyer hors de Coinbase.
**S7** : `move_funds` n'est pas idempotent ; l'idempotence est à construire.

## Décisions

### Prises par l'opérateur avant le cadrage

| # | Décision |
|---|---|
| D1 | Agent **séparé** d'Ubac, avec **sa propre clé CDP**, scopée sur *Primary*, permissions `view` + `trade` + `transfer` (`move_funds` l'exige, S7) |
| D2 | La clé d'Ubac garde `can_transfer=false` (§7). Ubac ne lit jamais la clé du convoyeur, et réciproquement |
| D3 | Garde-fous : liste blanche d'adresses Coinbase **activée et vide** ; *Primary* garde un solde minimal ; secret uniquement dans les secrets Scaleway |

### Réponses de l'opérateur (2026-09-28)

| # | Question | Réponse |
|---|---|---|
| Q1 | Objection : l'alternative sans clé (H1) | **1** — garder le convoyeur ; **mise en réel conditionnée** aux mesures MC1 et MC2 (CV20, CV21) |
| Q2 | Déclenchement | **1** — job **quotidien à 19:00 Europe/Paris** ; sans EUR, il ne fait rien |
| Q3 | Montant | **3** — **exactement 100 EUR**, montant attendu fixe ; les écarts sont tranchés par Q6 |
| Q4 | Réconciliation d'Ubac le lendemain | **1** — **prérequis** avant la mise en réel : une divergence entièrement expliquée par les flux enregistrés ne pousse plus `RECONCILIATION_DRIFT` (CV15) |
| Q5 | Gel de sept jours (§5.4) | **1** — **inchangé**, hors de ce cadrage |
| Q6 | EUR présent différent de 100 | **1** — EUR ≥ 100 : **exactement 100 EUR par passage**, un convoyage au plus ; le surplus reste dans *Primary* et est dit dans la notification ; deux virements en retard font 100 ce soir et 100 demain soir. EUR < 100 : rien, une ligne de journal |
| Q7 | Livraison | **1** — **même dépôt**, **image distincte** avec son propre point d'entrée, **définition de job Scaleway distincte**, déployée sur le même tag `v*` |
| Q8 | Ordre de conversion | **1** — **market `BUY` USDC-EUR en `quote_size` = 100 EUR** : exécution immédiate, taker ~0,60 % |
| Q9 | Accès à la base | **1** — **rôle Neon dédié** : `INSERT` sur `cash_flows` et accès à son propre journal, rien d'autre |
| Q10 | Calendrier | **2** — **`DRY_RUN` en octobre quoi qu'il arrive**, réel en novembre. Le virement d'octobre est convoyé à la main une dernière fois |

Décidé sans question et annoncé à l'opérateur en passe 2 : les notifications
passent par **ntfy**, sur le canal d'Ubac, préfixées « convoyeur » ; **pas
d'email**. L'apport apparaît déjà dans « Derniers apports » du rapport d'Ubac
(K8).

### Prises par ce cadrage

- **DC1. La conversion se fait dans *Primary*, jamais dans `ubac-agent`.** Seul
  de l'USDC traverse. `ubac-agent` ne voit jamais d'EUR (K6), et un apport s'y lit
  comme un mouvement d'USDC seul — le cas le plus simple de la spec des flux.
- **DC2. Les deux portefeuilles sont figés, et vérifiés.** La source est le
  portefeuille de la clé, constaté par `key_permissions` : `portfolio_type`
  `DEFAULT` et UUID égal à celui que l'opérateur a posé. La destination est
  l'UUID de `ubac-agent`, posé en configuration et comparé exactement. Aucun
  autre UUID n'est jamais passé à `move_funds`. Le convoyeur refuse de démarrer
  sur une clé qui n'a pas `can_transfer=true` — sans elle rien ne bouge, et le
  dire au démarrage vaut mieux que de convertir sans pouvoir transférer.
- **DC3. L'USDC de *Primary* appartient au convoyeur.** L'opérateur n'y détient
  pas d'USDC. C'est ce qui rend l'étape de transfert reprenable sans clé
  d'idempotence (S7) : la quantité à déplacer se relit sur l'exchange, et un
  transfert fait ne peut pas être refait puisque l'USDC n'est plus là. Un USDC
  inattendu dans *Primary* (au-delà de ce que le convoyeur a acheté) arrête le
  convoyage et alerte.
- **DC4. Le montant enregistré est l'USDC effectivement déplacé**, lu sur
  l'exchange (`filled_size` de l'ordre, S6, puis le solde relu), jamais le
  montant EUR ni un montant calculé. La note de la ligne porte l'EUR débité, les
  frais et l'identifiant de l'ordre.
- **DC5. Horodatage : l'instant du transfert.** `occurred_at` est l'instant
  constaté du `move_funds`, pas celui du virement SEPA ni celui de l'écriture.
  Avec K3, il tombe dans la fenêtre du prochain run d'Ubac.
- **DC6. Invariant de bout en bout.** Au démarrage du run d'Ubac qui suit un
  convoyage, **ou bien** l'USDC est dans `ubac-agent` **et** sa ligne
  `cash_flows` existe, **ou bien** ni l'un ni l'autre. Les étapes (achat,
  transfert, écriture) sont reprenables une à une, et le convoyeur tient un
  journal durable de chaque convoyage et de son étape, écrit **avant** chaque
  appel à l'exchange. La reprise se fait **dans le même passage** ; s'il ne peut
  pas rétablir l'invariant, le convoyeur alerte en `urgent` avant de rendre la
  main, soit environ douze heures avant le run (H2). Chaque passage commence par
  finir le convoyage que le journal laisse ouvert, avant d'en commencer un autre.
- **DC7. Une ligne `cash_flows` du convoyeur est reconnaissable.** Elle a une
  origine qui la distingue d'une saisie de l'opérateur et d'un flux détecté, et
  une clé naturelle dérivée du convoyage (l'identifiant d'ordre du `BUY`). La
  forme de la colonne est laissée au plan ; elle converge avec N2.
- **DC8. Un passage, un convoyage.** Le job ne boucle pas pour vider *Primary* :
  il convoie au plus 100 EUR (Q6) et laisse le reste au passage suivant. Un bug
  de reprise ne peut donc engager plus de 100 EUR par jour.
- **DC9. Pas d'argent à deviner.** Aucun `number` sur un montant : EUR et USDC en
  `decimal.js`, comme dans Ubac.

## Périmètre

### Inclus

1. Un job Scaleway **distinct** de celui d'Ubac, quotidien à 19:00
   Europe/Paris (Q2), avec sa définition, son déclencheur, ses secrets et son
   image propres (Q7), dans ce dépôt, déployé sur le même tag `v*`. Le job
   `deploy` met à jour les deux définitions ; ses contrôles d'Ubac (un seul
   déclencheur `daily`) restent vrais pour la définition d'Ubac.
2. La lecture des soldes EUR et USDC de *Primary* et des permissions de la clé.
3. L'achat d'USDC dans *Primary* : market `BUY` USDC-EUR de `quote_size`
   100 EUR (Q8), idempotent par `client_order_id` (S5).
4. Le `move_funds` de l'USDC acheté vers `ubac-agent`.
5. L'écriture de l'apport dans `cash_flows`, idempotente (DC7), avec un rôle
   Neon dédié qui n'a rien d'autre que cette insertion et son journal (Q9).
6. La reprise après panne entre deux étapes (DC6), et son journal.
7. Un `DRY_RUN` qui lit tout, journalise ce qu'il ferait, et n'écrit ni ordre,
   ni transfert, ni ligne.
8. Une notification ntfy par passage qui agit (succès, refus, reprise, panne)
   et la documentation : procédure de création de la clé et de la liste blanche,
   rôle Neon, secrets, geste de reprise.
9. Le lot côté Ubac que Q4 = 1 rend prérequis : une divergence entièrement
   expliquée par les flux enregistrés ne crie plus (CV15).

### Exclu explicitement

- **Toute permission de sortie pour Ubac** (D2) et toute lecture croisée des
  secrets.
- **Les retraits** : le convoyeur ne fait que des apports. Un retrait reste un
  geste de l'opérateur (N3 du plan des flux).
- **Un autre actif que l'EUR en entrée et l'USDC en sortie.**
- **Le rééquilibrage de l'apport** : le convoyeur dépose de l'USDC ; ce qu'Ubac en
  fait relève de sa stratégie (et du gel de K4).
- **La restriction IP de la clé** (S13) : inapplicable depuis un Job Scaleway.
  Rouverte si Scaleway offre une IP de sortie fixe.
- **La modification du gel de sept jours** (Q5 = 1) : tout apport, celui du
  convoyeur compris, gèle A sept jours. Un seuil serait un changement
  d'invariant d'Ubac, à cadrer à part.
- **La détection automatique des flux** (N5 à N8) : elle reste utile pour tout ce
  qui n'est pas l'apport mensuel.

## Hypothèses challengées

### H1. « Il faut une clé qui transfère » — l'alternative sans clé

**L'objection.** Le convoyeur met en production la première clé du projet
capable de faire bouger de l'argent hors de `ubac-agent`, et la documentation ne
permet pas de dire qu'elle ne peut pas le sortir de Coinbase (S10). Les deux
garde-fous qu'on attendrait ne sont pas démontrés : la restriction IP est
impossible (S13) et la liste blanche d'adresses ne dit rien des envois par API
ni des retraits EUR (S11). Le gain, lui, est de quelques gestes par mois.
L'alternative sans clé : un **achat récurrent d'USDC dans l'application**, un
**transfert manuel** *Primary* → `ubac-agent` (deux touches, S8), et la
**détection par Ubac** (N5 à N8 du plan des flux) pour l'enregistrement.

**Ce que le cadrage retient : le convoyeur (Q1 = 1), mise en réel conditionnée à
deux mesures.** L'objection est juste sur le risque et fausse sur sa conclusion :
le risque ne se règle pas en renonçant à la clé, il se borne. Une clé fuitée
n'atteint que *Primary* (S9 : les autres portefeuilles n'envoient rien), que
l'opérateur garde au minimum (D3) ; MC1 vérifie qu'elle n'en tire pas d'ailleurs,
MC2 qu'elle n'envoie rien dehors ; et le convoyeur n'engage jamais plus de
100 EUR par jour (DC8).

Ce que l'alternative ne règle pas : elle garde un geste manuel par mois, dont
l'oubli n'est plus perdu (la détection l'écrit) mais dont le retard est
tolérable ; et elle dépend du chemin long du plan des flux (N5 à N8, ~2 000
lignes) quand le convoyeur ne dépend que de N2 et d'un N10 réduit. Ce que le
convoyeur ne règle pas : une clé `transfer` dans les secrets Scaleway. C'est
pourquoi, s'il est retenu, sa mise en réel est **conditionnée à deux mesures**
(MC1, MC2 ci-dessous), qui transforment S10 et S11 de doutes en constats.

### H2. « Le convoyeur doit tourner juste avant le run d'Ubac »

Faux, et c'est K3 qui le dit : la fenêtre est faite d'instants. Un flux horodaté
à l'instant du transfert tombe dans la bonne sous-période **à n'importe quelle
heure**, pourvu que transfert et écriture aient lieu entre les deux mêmes runs
d'Ubac. Ce qui compte n'est pas d'être « avant 07:00 », c'est la **marge** entre
la fin du convoyage et le run suivant : c'est le temps disponible pour reprendre
une panne (DC6). D'où le passage à 19:00 (Q2) : douze heures de marge avant
le run de 07:00, et un virement SEPA crédité dans la journée est convoyé le soir
même.

### H3. « Convertir, c'est l'endpoint convert »

Non (S1) : convert ne connaît que USDC-USD, PYUSD-USD, EURC-EUR et PYUSD-USDC.
L'EUR → USDC est un ordre sur le carnet USDC-EUR, avec les frais d'un ordre
(S4) et l'idempotence d'un ordre (S5).

### H4. « `move_funds` est une opération comme une autre »

Non (S7) : sans clé d'idempotence ni identifiant rendu, un rejeu aveugle
transférerait deux fois. L'idempotence vient de DC3 : ce qu'il reste à déplacer
se relit sur l'exchange.

### H5. « Une liste blanche vide interdit toute sortie »

Implication logique, pas fait documenté (S11) : rien ne dit qu'elle couvre les
envois par API, ni les retraits EUR vers un compte bancaire. D'où MC2.

## Effet sur le plan des flux non enregistrés

Le plan `docs/plans/ubac-flux-non-enregistres.md` (branche non fusionnée) a été
écrit en excluant explicitement « le transfert automatique Primary →
`ubac-agent` ». Le convoyeur ne rouvre pas ce refus pour Ubac — c'est un autre
agent, une autre clé — mais il couvre le cas qui faisait de l'accident un régime
permanent : l'apport mensuel.

| Lot | Effet |
|---|---|
| **N1** (devises hors liste blanche hors divergence) | **Rendu inutile pour l'apport** : DC1 ne laisse plus d'EUR dans `ubac-agent`. Reste valable pour une devise égarée ; peut sortir du chemin critique |
| **N2** (origine et clé naturelle de `cash_flows`) | **Modifié et prérequis** : une troisième origine, celle du convoyeur (DC7) ; la clé naturelle du convoyeur est l'identifiant d'ordre |
| **N3, N4** (commande de saisie manuelle, dans l'image) | **Rendus inutiles pour l'apport** ; restent l'outil des retraits (F16, moitié retrait). Peuvent attendre |
| **N5 à N8** (résidu, frontière, alertes, écriture détectée) | **Hors du chemin de l'apport** : un apport enregistré par le convoyeur a un résidu nul (D2 des flux). Gardent leur objet — vol, retrait non annoncé, oubli — et deviennent le filet si le convoyeur échoue sans alerter |
| **N9** (rapport des flux) | **Partiellement fait** par #73 (« Derniers apports ») ; reste l'origine et les retraits |
| **N10** (une alerte par fait) | **Modifié** : sa part « divergence entièrement expliquée par des flux **enregistrés** » ne dépend plus de N8 et devient le prérequis de Q4 = 1 (CV15). La part « flux détecté » garde sa dépendance à N8. Dépend toujours de S13 (F21 cite E60) |
| **G1** (horodatage d'une saisie) | Sans objet pour le convoyeur (DC5) |
| **G2** (clé naturelle d'une saisie) | Inchangée pour la saisie ; le convoyeur a la sienne (DC7) |
| **G3, G4** | Inchangées |
| **M1** (surcharge d'entrypoint Scaleway) | **Sans objet pour le convoyeur** : image et définition de job propres (Q7 = 1). Reste posée pour N4 |

## Critères d'acceptation

Préfixe **CV** (`C`, `E`, `R`, `F` et `V` sont pris).

### Clé et frontière

1. **CV1.** Au démarrage, le convoyeur lit `key_permissions` et refuse, sans rien
   faire d'autre, une clé dont le portefeuille n'est pas l'UUID de *Primary*
   attendu, dont `portfolio_type` n'est pas `DEFAULT`, ou dont `can_transfer`
   n'est pas le booléen `true`. Chaque refus a sa sonde.
2. **CV2.** Aucun appel `move_funds` ne part avec une source autre que *Primary*
   ou une destination autre que l'UUID de `ubac-agent` configuré. Sonde : une
   destination altérée d'un caractère est refusée avant tout appel.
3. **CV3.** Le job d'Ubac ne porte aucune variable du convoyeur, et
   réciproquement ; les noms de variables sont distincts ; l'image du convoyeur
   n'a pas `daily-main` pour point d'entrée, ni celle d'Ubac le convoyeur (Q7). La clé du convoyeur
   posée dans Ubac est refusée par `permissionsFrom` (K1) — sonde existante,
   citée.
4. **CV4.** Aucune route de l'API v2 (envoi, retrait) n'existe dans le code du
   convoyeur ; un garde-fou de structure le vérifie, comme
   `test/structure.test.ts` le fait pour le noyau.

### Conversion

5. **CV5.** Avec moins de 100 EUR disponibles dans *Primary*, le convoyeur ne
   fait rien, n'envoie aucune notification, et le dit en une ligne de journal.
6. **CV6.** L'achat est un market `BUY` USDC-EUR de `quote_size` exactement
   `100` EUR, dont le `client_order_id` est dérivé de façon déterministe du
   convoyage ; un rejeu rend l'ordre existant (S5) et n'en crée pas un second.
7. **CV7.** Avec 100 EUR ou plus, un passage engage exactement 100 EUR, jamais
   plus (Q6, DC8) ; le surplus est laissé dans *Primary* et chiffré dans la
   notification. Sonde : 250 EUR donnent 100 EUR ce passage, 100 le suivant,
   puis rien, avec 50 EUR signalés.

### Transfert

8. **CV8.** Le montant déplacé est l'USDC reçu par l'ordre (`filled_size`),
   relu sur l'exchange, en `decimal.js`.
9. **CV9.** Un convoyage interrompu après l'achat et avant le transfert reprend
   au passage suivant sans racheter ; interrompu après le transfert, il ne
   transfère pas une seconde fois (DC3). Chaque cas a sa sonde.
10. **CV10.** Un USDC présent dans *Primary* qui n'est pas celui d'un convoyage en
    cours arrête le convoyage, sans transfert, avec une alerte.

### Enregistrement

11. **CV11.** Chaque transfert réussi laisse exactement une ligne `cash_flows`
    d'origine convoyeur, du montant de CV8, horodatée à l'instant du transfert
    (DC5) ; un rejeu n'en écrit pas une seconde.
12. **CV12.** Sonde de fenêtre : un transfert à T entre deux photos est compté
    par `netFlow()` dans la sous-période qui se ferme au run suivant, et
    l'indice de croissance ne monte pas du montant de l'apport.
13. **CV13.** Si transfert et ligne ne sont pas tous deux présents à la fin d'un
    passage (DC6), le convoyeur pousse une alerte `urgent` qui dit quelle étape
    manque et ce que le run de 07:00 va lire.
14. **CV14.** L'apport gèle le déclencheur A sept jours (K4, inchangé) : sonde
    sur la ligne écrite par le convoyeur.

### Ubac le lendemain

15. **CV15.** Prérequis (Q4 = 1) : le lendemain d'un convoyage, une divergence
    de la ligne USDC **entièrement expliquée** par les lignes `cash_flows` de la
    période ne pousse pas `RECONCILIATION_DRIFT`. Sonde : un apport de 7 % de la
    ligne USDC, enregistré par le convoyeur, qui crie aujourd'hui (K5). Une
    divergence que les flux n'expliquent qu'en partie crie comme aujourd'hui.
    La resynchronisation, `ETAT_RESYNCHRONISE` et E60 ne changent pas.

### DRY_RUN, notification, exploitation

16. **CV16.** En `DRY_RUN`, le convoyeur lit soldes et permissions, calcule
    l'achat et le transfert, les journalise, et n'appelle ni création d'ordre,
    ni `move_funds`, ni écriture en base.
17. **CV17.** Chaque passage qui fait quelque chose (convoyage, refus, reprise,
    panne) envoie une notification ntfy, préfixée « convoyeur », qui dit l'EUR
    débité, l'USDC reçu, les frais, l'étape atteinte et l'EUR laissé dans
    *Primary* ; un passage sans convoyage n'envoie rien. Aucun email.
18. **CV18.** La procédure de création de la clé du convoyeur et d'activation de
    la liste blanche vide est documentée, sur le modèle de
    `docs/cle-coinbase.md`, et cite les sources S7 à S13.

### Base

19. **CV19.** Le rôle Neon du convoyeur peut insérer dans `cash_flows` et
    lire / écrire son journal ; une mise à jour ou une suppression dans
    `cash_flows`, et toute écriture dans `decisions`, `snapshots` ou `orders`,
    lui sont refusées par la base. Sonde contre la base de test.

### Mesures avant la mise en réel

20. **CV20 (MC1).** Mesuré et rapporté dans Orca : la clé du convoyeur, scopée
    sur *Primary*, **ne peut pas** faire `move_funds` depuis un autre portefeuille
    que *Primary* (sinon toute la fortune du compte est à portée de la clé).
21. **CV21 (MC2).** Mesuré et rapporté dans Orca : avec la liste blanche activée
    et vide, un envoi de crypto par l'API v2 depuis *Primary* avec cette clé est
    refusé. Le résultat pour un retrait EUR est noté, quel qu'il soit.
22. **CV22 (MC3).** Mesuré : `move_funds` accepte l'USDC de *Primary* vers
    `ubac-agent` avec cette clé, et le solde relu juste après le reflète.

23. **CV23 (Q10 = 2).** Le virement d'octobre 2026 passe en `DRY_RUN` : le
    journal du passage qui le voit dit l'ordre et le transfert qu'il aurait
    faits, et rien n'a bougé. Le réel n'est activé qu'après CV15 fusionné et
    CV20 à CV22 rapportés, au plus tôt pour le virement de novembre.

Si MC1 ou MC2 échoue, la mise en réel n'a pas lieu ; la décision revient à
l'opérateur par Orca.

## Incertitudes

- **U1. Portée de `transfer`** (S10). Levée par MC1 et MC2, pas par la lecture.
- **U2. Frais sur USDC-EUR.** Le palier affiché est 0,40 / 0,60 % ; une paire
  stable peut être à 0 % maker. Sur 100 EUR, l'écart est de 0 à 0,60 EUR par
  mois. Lu par `transaction_summary` au premier convoyage, rapporté.
- **U3. Instant où l'EUR SEPA devient négociable** (S14) : non documenté. Un
  passage quotidien l'absorbe ; un EUR crédité mais bloqué est un « rien à
  faire » du jour.
- **U4. « *Primary* garde un solde minimal » (D3)** est lu comme un garde-fou de
  surface : l'opérateur ne laisse dans *Primary* que ce que le convoyeur doit
  voir passer, puisque c'est tout ce qu'une clé fuitée pourrait atteindre. Ce
  n'est pas une règle du convoyeur, qui ne lit que le seuil de 100 EUR (Q6).
  Conséquence de Q6 : un EUR que l'opérateur déposerait pour un autre usage
  serait convoyé par tranches de 100 ; *Primary* ne doit donc porter d'EUR que
  pour le convoyeur.
- **U5. Emplacement du journal du convoyeur.** Table dédiée dans la base d'Ubac,
  accessible au seul rôle du convoyeur (Q9) ; sa forme est laissée au plan.
  Ubac n'a pas à la lire.
- **U6. Calendrier (Q10 = 2).** Virement du **27 octobre 2026** : `DRY_RUN`,
  convoyé à la main une dernière fois, et saisi comme aujourd'hui. Virement de
  **novembre** : premier convoyage réel, si N2 (modifié), le convoyeur, le lot
  de CV15 et S13 sont fusionnés, et MC1 à MC3 rapportés.
- **U7. Heure d'été.** 19:00 Europe/Paris vaut 17:00 UTC l'été, 18:00 UTC
  l'hiver ; seule compte la marge de ~12 h avant 07:00 (H2), pas l'heure UTC.
- **U8. Le déploiement à deux définitions** (Q7) touche le job `deploy`
  (`docs/integration-continue.md` §8), qui relit aujourd'hui une seule
  définition. Sa forme est laissée au plan ; ses contrôles ne doivent pas
  s'affaiblir pour Ubac.
- **U9. La panne muette.** Un conteneur tué entre le transfert et l'écriture,
  sans pouvoir alerter, n'est vu qu'au passage suivant, donc **après** un run
  d'Ubac : l'apport y est lu comme une performance et l'erreur est définitive
  (K3). Le journal le rend visible le lendemain soir (alerte `urgent`), pas
  réparable. Le filet est la détection du plan des flux (N5 à N8) ; faute d'elle,
  le cas reste possible et assumé, à une fois par panne.
