# Ubac : agent de rééquilibrage crypto

Version 2.0 · OLA Alpine Solutions · Olivier Laurendeau

> Changement majeur depuis la v1 : la stratégie de production passe du **ladder à ancre** au **rééquilibrage à bandes**. Le ladder est conservé en shadow comme benchmark. La table `strategy_state` disparaît.

---

## 1. Objectif

Maintenir une allocation cible entre BTC, ETH et USDC sur Coinbase Advanced Trade, avec rééquilibrage automatique quand une ligne sort de sa bande de tolérance. Exécution quotidienne, garde-fous déterministes, rapport par email.

Le rééquilibrage à bandes formalise ce que l'historique d'ordres manuels 2024-2026 faisait déjà d'instinct : acheter quand le poids crypto baisse, alléger quand il monte. La version systématique supprime la décision discrétionnaire, qui était de l'aveu même de l'opérateur le maillon faible du dispositif côté vente.

### Non-objectifs

- Pas de LLM dans la boucle de décision.
- Pas de trading intraday, pas de levier, pas de vente à découvert.
- Pas de prédiction de marché, pas d'analyse de news.
- Pas d'interface web. Le rapport email et le CLI suffisent.

### Ce qui rend cette stratégie plus simple que le ladder

L'état de la stratégie **est le portefeuille lui-même**. Il n'y a rien à persister entre deux runs : on lit les soldes réels, on calcule les poids, on compare aux cibles. Toute la classe de bugs liés à une ancre désynchronisée disparaît. Et l'exposition est bornée par construction, alors qu'un ladder sans plafond peut vider le compte dans une baisse prolongée.

---

## 2. Architecture

```
src/
  core/            pur, zéro IO, 100 % testé
    strategy/      rebalance.ts (prod) | ladder.ts | dca.ts (shadow)
    risk.ts        validation déterministe des intentions
    portfolio.ts   poids, PRU, exposition
    benchmark.ts   hold, Sharpe, max drawdown
    types.ts
  adapters/
    coinbase.ts    ccxt, exécution + lecture de compte
    market.ts      OHLCV, historique
    db.ts          drizzle
    mailer.ts      Brevo
    notifier.ts    ntfy
  jobs/
    daily.ts       boucle principale
    reconcile.ts   réconciliation seule
    liquidate.ts   sortie propre vers USDC
```

`core` ne connaît que des interfaces et une horloge injectée. C'est ce qui rend le backtest gratuit : on rejoue le code de production avec un adapter de données historiques.

### Flux de décision

```
soldes réels (Coinbase) + prix du jour
        ↓
  Strategy.decide()  →  Intent[]        (vide dans le cas nominal)
        ↓
  Risk.validate()    →  Order[] | Rejection[]   (déterministe, non contournable)
        ↓
  Executor.place()   →  post-only limit, client_order_id déterministe
        ↓
  Reconcile          →  état réel du compte fait foi
```

`Risk.validate` n'a pas de mode bypass, même en dry-run.

---

## 3. Stack

| Composant | Choix | Note |
|---|---|---|
| Runtime | Node 22, TypeScript strict, ESM | job, pas de serveur |
| Base | Postgres (Neon, eu-central-1) | chaîne pooled |
| ORM | Drizzle | migrations via `drizzle-kit push` depuis le poste, jamais depuis le job |
| Validation | Zod | config et payloads exchange |
| Décimales | decimal.js | **aucun `number` flottant sur prix, quantités et poids** |
| Exchange | ccxt (Coinbase Advanced) | auth par clés CDP / JWT |
| Tests | Vitest | |
| Email | Brevo API HTTP `/v3/smtp/email` | pas de SMTP en serverless |
| Push | ntfy auto-hébergé | alertes uniquement |
| Hébergement | Scaleway Serverless Jobs (fr-par) | cron UTC |
| CI/CD | GitHub Actions → Scaleway Container Registry | |

---

## 4. Modèle de données

Pas de table d'état de stratégie. Le portefeuille est l'état.

```sql
-- Journal immuable de chaque run, y compris les runs sans action
CREATE TABLE decisions (
  id               uuid PRIMARY KEY,
  run_date         date NOT NULL,
  strategy         text NOT NULL,           -- 'rebalance' | 'ladder' | 'dca'
  is_shadow        boolean NOT NULL,
  trigger          text NOT NULL,           -- 'NONE' | 'CASH_BAND' | 'RATIO_BAND'
  reason           text NOT NULL,           -- lisible : poids constatés vs bandes
  weights_before   jsonb NOT NULL,          -- {BTC: 0.47, ETH: 0.28, USDC: 0.25}
  weights_target   jsonb NOT NULL,
  legs             jsonb NOT NULL,          -- [{asset, side, amountUsdc}]
  risk_verdict     text NOT NULL,           -- 'ACCEPTED' | 'REJECTED:<code>'
  git_sha          text NOT NULL,
  created_at       timestamptz NOT NULL
);
CREATE UNIQUE INDEX ON decisions (run_date, strategy, is_shadow);

CREATE TABLE orders (
  client_order_id  text PRIMARY KEY,        -- déterministe, voir §7
  decision_id      uuid REFERENCES decisions(id),
  exchange_id      text,
  side             text NOT NULL,
  asset            text NOT NULL,
  requested_qty    numeric(20,8) NOT NULL,
  limit_price      numeric(20,8) NOT NULL,
  status           text NOT NULL,           -- 'PENDING'|'FILLED'|'PARTIAL'|'CANCELLED'|'REJECTED'
  filled_qty       numeric(20,8),
  filled_price     numeric(20,8),
  fees             numeric(20,8),
  created_at       timestamptz NOT NULL,
  settled_at       timestamptz
);

-- Snapshot quotidien pour le rapport et les courbes de benchmark
CREATE TABLE snapshots (
  run_date         date PRIMARY KEY,
  total_value_usdc numeric(20,8) NOT NULL,
  weights          jsonb NOT NULL,
  positions        jsonb NOT NULL,
  benchmarks       jsonb NOT NULL,          -- {hold_btc, hold_5050, ladder, dca}
  created_at       timestamptz NOT NULL
);

-- Traçabilité des apports et retraits, nécessaire au calcul de performance
CREATE TABLE cash_flows (
  id               uuid PRIMARY KEY,
  occurred_at      timestamptz NOT NULL,
  amount_usdc      numeric(20,8) NOT NULL,  -- positif = apport
  note             text
);
```

L'index unique sur `decisions` garantit l'idempotence : un second run le même jour ne peut pas produire une seconde décision.

Les `cash_flows` ne sont pas cosmétiques : sans eux, un apport se lit comme une performance et fausse tous les benchmarks. Le rendement doit être calculé en time-weighted return, pas en variation de valeur brute.

---

## 5. Stratégie de production : rééquilibrage à bandes

### 5.1 Allocation cible

| Ligne | Cible | Bande (écart relatif) | Fourchette absolue |
|---|---|---|---|
| BTC | 40 % | | |
| ETH | 30 % | | |
| USDC | 30 % | 20 % | 24 % – 36 % |

### 5.2 Deux déclencheurs distincts

BTC et ETH sont corrélés à environ 0,85. Ils montent et descendent ensemble, donc la bande qui travaille réellement est **crypto contre cash**. Le rééquilibrage entre BTC et ETH est un pari secondaire sur leur ratio, plus faible et plus bruyant. D'où deux déclencheurs séparés, avec des tolérances différentes.

**Déclencheur A : bande de cash (le principal)**

```
si poids(USDC) < 0.24 ou poids(USDC) > 0.36
  → rééquilibrage complet : toutes les lignes ramenées à la cible
```

C'est ici que vient l'essentiel de la valeur du système. Attendez-vous à ce que 80 % des déclenchements viennent de cette ligne.

**Déclencheur B : ratio BTC/ETH (secondaire)**

```
ratio = poids(BTC) / poids(ETH)          cible = 40/30 = 1.333
si ratio < 0.93 ou ratio > 1.73          (± 30 % relatif, bande volontairement large)
  → rééquilibrage BTC ↔ ETH uniquement, ligne cash inchangée
```

La bande est plus large que celle du cash précisément parce que ce pari est moins fondé.

### 5.3 Retour à la cible, pas au bord de bande

Quand un déclencheur s'active, on ramène les lignes **à la cible exacte**, pas au bord de la bande. Le retour au bord trade moins mais laisse dériver le portefeuille, et le gain en frais est négligeable ici (voir §5.5). Choix par défaut, modifiable en config via `rebalanceMode: "target" | "band_edge"`.

### 5.4 Apports d'argent frais

Un virement modifie les poids et peut déclencher un rééquilibrage immédiat, ce qui revient à investir la totalité de l'apport le jour même.

Comportement par défaut : **carence de 7 jours**. Un apport enregistré dans `cash_flows` gèle le déclencheur A pendant 7 jours, puis le système reprend son fonctionnement normal. Cela évite qu'un apport se transforme en achat massif au plus mauvais moment, sans pour autant laisser du cash dormir indéfiniment.

Alternative disponible en config (`newCashPolicy: "immediate" | "delay7d" | "manual"`).

### 5.5 Coût

Un rééquilibrage typique fait bouger 6 à 8 % de la valeur du portefeuille. À 0,25 % en maker, cela coûte environ **0,02 % de la valeur totale** par événement. Avec 4 à 8 déclenchements par an, le coût annuel du système est de l'ordre de 0,1 %.

C'est un ordre de grandeur en dessous du ladder (0,55 % par aller-retour). La contrainte de conception n'est donc plus le coût mais la **fréquence de déclenchement** : des bandes trop serrées produiraient du bruit sans créer de valeur.

### 5.6 Stratégies shadow

Tournent en simulation sur les mêmes données, apparaissent dans le rapport quotidien, ne passent aucun ordre.

- **Ladder** : ancre unique, achat à -7 % (BTC) / -9 % (ETH), vente à +12 % / +15 %. Le concurrent direct, conservé pour arbitrer empiriquement.
- **DCA** : achat d'un montant fixe à date fixe. Benchmark de simplicité. Si le rééquilibrage ne bat pas le DCA sur 12 mois, il ne se justifie pas.
- **Hold** : BTC seul et 50/50 BTC/ETH, calculés en `benchmark.ts`.

---

## 6. Couche risque

Déterministe, testée exhaustivement, appliquée à toute intention quelle que soit son origine.

| Règle | Valeur | Code de rejet |
|---|---|---|
| Whitelist d'actifs | BTC, ETH, USDC uniquement | `ASSET_NOT_ALLOWED` |
| Devise de cotation | USDC exclusivement, jamais EUR | `QUOTE_NOT_ALLOWED` |
| Exposition max par actif | 50 % de la valeur totale | `MAX_EXPOSURE` |
| Réserve USDC minimale | 15 % après rééquilibrage | `MIN_CASH` |
| Ampleur max d'un rééquilibrage | 25 % de la valeur totale en un run | `REBALANCE_TOO_LARGE` |
| Jambe minimale | 200 USDC, sinon la jambe est ignorée | `LEG_TOO_SMALL` |
| Fréquence minimale | 7 jours entre deux rééquilibrages complets | `COOLDOWN` |
| Écart au prix marché | rejet si limite > 2 % du mid | `PRICE_SANITY` |
| Cohérence de solde | rejet si divergence > 1 % entre exchange et état interne | `RECONCILIATION_DRIFT` |

### Les deux règles qui comptent vraiment

**`REBALANCE_TOO_LARGE`** est le garde-fou central de cette stratégie. Un bug de calcul de poids, un prix aberrant renvoyé par l'API, un solde mal lu : tous se manifestent par un rééquilibrage démesuré. Plafonner l'ampleur à 25 % de la valeur totale transforme un bug catastrophique en anomalie visible et récupérable.

**`COOLDOWN`** empêche l'oscillation. Sans lui, un portefeuille posé juste au bord d'une bande pourrait déclencher plusieurs jours d'affilée sur du bruit de marché.

### Pas de stop-loss

Un stop-loss est incompatible avec un système qui rééquilibre vers la cible, donc qui achète mécaniquement les baisses. Il transformerait chaque repli en perte réalisée au pire moment.

Le contrôle du risque repose sur l'**allocation cible elle-même** : la ligne USDC est le coussin, et un plafond d'exposition à 50 % par actif borne le pire cas. Un drawdown de 25 % déclenche une **alerte et une suspension des rééquilibrages**, pas une vente. La décision de sortir reste humaine.

---

## 7. Exécution Coinbase

- Portefeuille Coinbase **dédié**, clé API scopée dessus uniquement. Le portefeuille principal doit être invisible pour l'agent. Protection structurelle, pas logicielle.
- Permissions : lecture + trade. **Jamais de permission de retrait.**
- Ordres **limit post-only** exclusivement. Un ordre qui s'exécuterait en taker est rejeté par l'exchange plutôt qu'exécuté au prix fort. Cela préserve le statut maker (0,25 % contre 0,6 %).
- Prix limite : mid ± 0,1 %.
- `client_order_id` déterministe : `sha256(run_date | asset | side | leg_index)` tronqué. Un rejeu du job ne peut pas doubler l'ordre.
- Paires **exclusivement en USDC** (voir §11).

### Rééquilibrage partiellement exécuté

Cas propre à cette stratégie : un rééquilibrage comporte plusieurs jambes, et une jambe peut ne pas s'exécuter (post-only rejeté, marché qui bouge). Le portefeuille se retrouve dans un état intermédiaire.

Ce n'est **pas une erreur** et il ne faut surtout pas compenser dans la foulée. Le run suivant relira les poids réels et recalculera. La stratégie est sans mémoire, donc naturellement auto-correctrice. Il faut simplement que le cooldown de 7 jours n'empêche pas cette correction : le cooldown s'applique aux rééquilibrages **complets réussis**, pas à un run qui suit une exécution partielle.

### Réconciliation

Chaque run commence par la réconciliation, avant toute décision :

1. Lire les soldes réels et les ordres ouverts sur Coinbase.
2. Mettre à jour les `orders` en `PENDING` selon leur statut réel.
3. Annuler tout ordre limit non exécuté datant de plus de 24 h.
4. Comparer soldes réels et état interne. Divergence > 1 % : abandon du run et alerte.

L'état de l'exchange fait toujours foi. L'état interne n'est qu'un cache.

---

## 8. Job quotidien

Cron Scaleway : `0 7 * * *` (UTC). Les bougies daily crypto clôturent à 00:00 UTC, donc pas de problème de changement d'heure.

```
1. Healthcheck de démarrage, log du git_sha
2. Réconciliation (§7) → abandon si divergence
3. Lecture des soldes réels + prix (OHLCV 200j)
4. Calcul des poids, détection des cash_flows récents
5. Pour chaque stratégie :
     decide() → Intent[]
     risk.validate() → verdict
     persistance dans `decisions` (y compris trigger NONE)
6. Exécution des jambes de la stratégie active uniquement
7. Calcul des benchmarks (time-weighted) et snapshot
8. Envoi du rapport Brevo
9. Ping du healthcheck externe
```

Timeout 5 min. **Max retries = 0** : un retry automatique après timeout partiel pourrait doubler une jambe. Le `client_order_id` protège, mais on ne dépend pas d'une seule ligne de défense.

---

## 9. Notifications

### Rapport quotidien (Brevo, après chaque run)

- Valeur totale, P&L jour et cumulé en **time-weighted return** (neutralise les apports).
- **Poids actuels vs cibles vs bandes**, avec la distance au prochain déclenchement. C'est l'information la plus utile du rapport : elle dit quand quelque chose va se passer.
- Décision du jour, y compris quand le trigger est `NONE`.
- Comparaison au hold BTC, au hold 50/50, au ladder shadow et au DCA shadow.
- Sharpe glissant 90 jours et max drawdown.

Domaine authentifié (SPF, DKIM) sur `olalpinesolutions`, sinon les rapports finissent en spam. Tag `daily-report` sur chaque envoi. HTML inline minimal, lisible sur téléphone.

### Alertes (ntfy, push immédiat)

Rééquilibrage exécuté, drawdown > 25 %, `REBALANCE_TOO_LARGE` déclenché, divergence de réconciliation, jambe rejetée, job en échec.

Le mail est un mauvais canal d'alerte : un drawdown le dimanche ne doit pas attendre le lundi.

### Surveillance de l'absence

L'absence de rapport n'alerte de rien par elle-même. Healthcheck externe (Healthchecks.io) pingé en fin de run, qui alerte si le ping manque. La surveillance ne doit pas dépendre du système surveillé.

---

## 10. Infrastructure et déploiement

### Neon

Projet en **AWS eu-central-1 (Francfort)**, sinon région US par défaut. Chaîne de connexion pooled. L'auto-suspend réveille la base au premier connect, quelques centaines de ms, sans importance ici.

### Scaleway Serverless Jobs

1. Container Registry privé, namespace `fr-par`.
2. Build **explicitement `linux/amd64`** (sinon crash silencieux depuis un Mac ARM).
3. Job : 256 Mo RAM, 0,1 vCPU.
4. Secrets en **variables secrètes** : `DATABASE_URL`, `COINBASE_API_KEY`, `COINBASE_API_SECRET`, `BREVO_API_KEY`, `NTFY_TOKEN`, `HEALTHCHECK_URL`.
5. Timeout 5 min, max retries 0, cron trigger.

### GitHub Actions

```yaml
jobs:
  test:      # bloquant, couche risque incluse
  build:     # needs: test
  deploy:    # needs: build, environment protégé
```

- Login registry : username `nologin`, password = secret key Scaleway.
- **Tag par SHA de commit, jamais `latest`.** Le SHA est persisté dans `decisions` : on doit pouvoir dire quelle image tournait le jour d'une décision douteuse.
- Application IAM dédiée, policy limitée à `ContainerRegistryFullAccess` et `ServerlessJobsFullAccess`.
- `workflow_dispatch` avec flag `DRY_RUN=true` : même image, adapter Coinbase remplacé par un mock qui log. Permet de valider une modification de bandes sur les données réelles du jour sans engager quoi que ce soit.

---

## 11. Fiscalité

Contrainte qui a un impact direct sur le code :

- En France, une cession crypto vers EUR est un **fait générateur d'imposition**, un échange crypto vers crypto ne l'est pas. La jambe cash doit donc être **USDC et jamais EUR**. La couche risque rejette toute paire `*-EUR` (`QUOTE_NOT_ALLOWED`).
- L'historique 2024-2025 contient des ventes SOL-EUR et ETH-EUR. L'agent ne doit reproduire ce schéma sous aucune condition.
- Avantage du rééquilibrage à bandes sur le ladder : **4 à 8 événements par an contre 15 à 25**. Nettement moins de cessions à tracer, et un profil d'activité bien moins susceptible d'être requalifié en BIC professionnels, ce qui n'est pas neutre avec une SASU à côté.
- Prévoir un export CSV des cessions (`orders` avec fills et frais) pour la déclaration. Penser au formulaire 3916-bis pour les comptes d'actifs numériques à l'étranger.

Ces points sont des contraintes techniques constatées, pas un conseil fiscal. À cadrer avec le comptable avant passage en réel.

---

## 12. Tests

- **Couche risque : couverture 100 %, non négociable.** Chaque code de rejet a son test.
- **Calcul de poids** : property test, la somme des poids vaut toujours 1 aux arrondis près.
- **Symétrie du rééquilibrage** : après application des jambes calculées, les poids résultants doivent égaler la cible. C'est le test central de `rebalance.ts`.
- **Exécution partielle** : simuler une jambe non exécutée et vérifier que le run suivant recalcule correctement sans compenser deux fois.
- **Idempotence** : deux runs consécutifs le même jour ne produisent qu'une décision et qu'un jeu d'ordres.
- **Apports** : vérifier que la carence de 7 jours gèle bien le déclencheur A et que le time-weighted return ne compte pas l'apport comme une performance.
- **Rejeu de l'historique réel** : les prix BTC/ETH de 2024-2026 servent de jeu de données pour comparer bandes, ladder et DCA sur la même période.
- **Attention au biais de backtest** : un backtest sur données antérieures à la conception valide l'implémentation, pas la stratégie. Seul le forward testing compte.

---

## 13. Phases

| Phase | Contenu | Durée | Sortie |
|---|---|---|---|
| 0 | `core` + tests + comparaison des 3 stratégies sur l'historique | 1 soirée | paramètres de bandes validés |
| 1 | Adapters, DB, job, rapport Brevo. Mode observation, **aucune exécution** | 1 soirée | rapport quotidien reçu, 3 stratégies en shadow |
| 2 | Infra Scaleway + Neon + CI/CD | 1 soirée | job en production, toujours sans exécution |
| 3 | Activation de l'exécution | 1 mois | premiers rééquilibrages réels |
| 4 | Ajustement des bandes selon les données observées | | |

Ne pas raccourcir la phase 1. Un mois de rapports quotidiens sans exécution coûte zéro euro et révèle la quasi-totalité des bugs de logique.

Point spécifique à cette stratégie : avec 4 à 8 déclenchements par an, la phase 1 pourrait ne montrer **aucun** rééquilibrage. C'est normal. La validation en phase 1 porte sur la justesse des poids affichés et sur la distance annoncée au prochain déclenchement, pas sur l'observation d'un événement.

---

## 14. Sortie propre

Commande `jobs/liquidate.ts`, déclenchable en CLI et depuis un bouton d'action ntfy :

1. Annulation de tous les ordres ouverts.
2. Liquidation des positions vers USDC en limit post-only.
3. Désactivation du cron trigger.
4. Rapport final avec le récapitulatif des cessions.

À écrire dès la phase 1. Le jour où on veut arrêter, on n'improvise pas un script à la main.

---

## Annexe : paramètres par défaut

```jsonc
{
  "strategy": "rebalance",
  "shadowStrategies": ["ladder", "dca"],

  "rebalance": {
    "targets": { "BTC": 0.40, "ETH": 0.30, "USDC": 0.30 },
    "cashBandRelative": 0.20,        // USDC déclenche hors de 24 % – 36 %
    "ratioBandRelative": 0.30,       // BTC/ETH déclenche hors de 0.93 – 1.73
    "rebalanceMode": "target",       // "target" | "band_edge"
    "newCashPolicy": "delay7d"       // "immediate" | "delay7d" | "manual"
  },

  "ladder": {                        // shadow uniquement
    "BTC": { "buyStep": 0.07, "sellStep": 0.12, "trancheUsdc": 500 },
    "ETH": { "buyStep": 0.09, "sellStep": 0.15, "trancheUsdc": 500 }
  },

  "risk": {
    "maxExposurePerAsset": 0.50,
    "minCashPct": 0.15,
    "maxRebalanceMagnitudePct": 0.25,
    "minLegUsdc": 200,
    "cooldownDays": 7,
    "priceSanityPct": 0.02,
    "reconciliationDriftPct": 0.01,
    "drawdownAlertPct": 0.25
  },

  "execution": { "postOnly": true, "quoteCurrency": "USDC", "limitOffsetPct": 0.001 },
  "schedule": { "cron": "0 7 * * *", "timezone": "UTC" }
}
```

Coût de référence : environ 0,02 % de la valeur du portefeuille par rééquilibrage, soit de l'ordre de 0,1 % par an à 4-8 déclenchements.
