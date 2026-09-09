# Ubac phase 0 : noyau `core` et rejeu historique

Cadrage du 2026-09-09 · restreint et durcit `docs/specs/ubac-rebalance.md` v2.0 pour la seule phase 0.

## Besoin

Livrer le noyau `core` d'Ubac — pur, sans IO, entièrement testé — et un harnais de rejeu de l'historique 2024-2026 qui compare les stratégies entre elles.
Aucun adapter, aucune base de données, aucun ordre, aucune infrastructure.
En cas de contradiction avec la v2.0 sur le périmètre phase 0, **c'est ce fichier qui fait foi**.

## Perimetre

### Inclus

**Modules `core/`** — purs, zéro IO, horloge injectée :

| Module | Contenu |
|---|---|
| `core/types.ts` | `Intent`, `Order`, `Rejection`, `Weights`, `Candle`, `CashFlow`, `Verdict` |
| `core/portfolio.ts` | poids par actif, valeur totale en USDC, exposition par actif |
| `core/strategy/rebalance.ts` | déclencheur A (bande cash) ; déclencheur B (bande ratio) derrière un drapeau de configuration |
| `core/strategy/ladder.ts` | shadow, ancre unique |
| `core/strategy/dca.ts` | shadow, montant fixe à date fixe |
| `core/risk.ts` | les 9 règles de rejet, déterministes, sans mode bypass |
| `core/benchmark.ts` | hold BTC, hold 50/50, TWR, Sharpe glissant 90 j, max drawdown |
| `core/order-id.ts` | `client_order_id` déterministe (fonction de hachage pure, donc dans `core`) |

**Stratégies évaluées par le rejeu** — quatre configurations, aucune n'exécute quoi que ce soit en phase 0 :

| Nom | Rôle | Déclencheurs |
|---|---|---|
| `rebalance` | production (inactive en phase 0) | A seul |
| `rebalance_ab` | **shadow** | A + B |
| `ladder` | shadow | ancre |
| `dca` | shadow | calendaire |

**Harnais de rejeu** — hors `core`, alimenté par une fixture versionnée de bougies daily BTC-USDC et ETH-USDC du 2024-01-01 au 2026-08-31, plus une fixture de `cash_flows`. Produit un tableau comparatif : valeur finale, TWR, Sharpe 90 j, max drawdown, nombre de déclenchements par stratégie.

### Exclu explicitement

- Tout `adapters/` : Coinbase, ccxt, marché, Drizzle, Brevo, ntfy.
- Tout `jobs/` : `daily.ts`, `reconcile.ts`, `liquidate.ts`.
- Postgres, Neon, migrations, schéma SQL. Aucune table n'est créée en phase 0.
- Scaleway, Docker, GitHub Actions, cron, healthcheck.
- Rapport email, notifications push.
- Export CSV des cessions et tout ce qui touche à la déclaration fiscale.
- **Le PRU.** Il n'a d'usage que pour l'export fiscal, qui est hors phase 0, et sa méthode de calcul n'est pas tranchée (voir *Zones d'incertitude*). L'exclure évite de figer un choix fiscal par accident dans `portfolio.ts`.
- **Toute conclusion sur la valeur de la stratégie.** Le rejeu valide l'implémentation, pas les paramètres.

## Decisions prises pendant le cadrage

| Question | Reponse retenue |
|---|---|
| Objet du cadrage | Durcir la spec existante, restreinte à la phase 0 |
| Statut de `ubac-rebalance.md` | Modifiable, non gelée ; ce fichier prévaut sur le périmètre phase 0 |
| Horizon couvert | Phase 0 uniquement |
| Livrable | Fichier neuf `docs/specs/ubac-phase-0.md`, référence de la phase 0 |
| Critère de sortie de phase 0 | **Purement technique** : tests verts, `core/risk.ts` à 100 %, les 4 stratégies tournent sur l'historique. Aucun résultat n'est jugé. |
| Sort du déclencheur B | Passe en **shadow** (`rebalance_ab`). Promu en production plus tard si les données le justifient. |
| `minCashPct` | Relevé de **15 % à 22 %**, pour qu'il borde réellement le mode `band_edge` à 24 % au lieu d'être une règle morte |
| Priorité A × B | **A l'emporte.** Si A tire, le rééquilibrage complet remet déjà le ratio à la cible et B n'est pas évalué. B n'est évalué que si A ne tire pas. |
| Cooldown de B | B a **son propre cooldown de 7 jours**, distinct de celui de A. Le trou de la v2.0 est comblé. |
| Source des bougies | Fixture versionnée dans le dépôt, pas d'appel réseau |

## Hypotheses challengees

| Hypothese | Verdict |
|---|---|
| Le déclencheur B (bande ratio BTC/ETH) mérite d'être en production dès le départ | **Changé.** B est un pari que la v2.0 qualifie elle-même de « moins fondé et plus bruyant » ; il n'est couvert par aucun cooldown dans la v2.0, donc il pouvait tirer tous les jours ; et avec 1 à 3 événements par an, son P&L n'est pas attribuable. Il passe en shadow. |
| `minCashPct` à 15 % protège la réserve de cash | **Changé.** En mode `target` le cash finit à 30 %, en `band_edge` à 24 % : la règle ne pouvait jamais mordre. Une règle morte couverte à 100 % donne une fausse assurance. Relevée à 22 %. |
| La phase 0 sort sur « paramètres de bandes validés » (v2.0 §13) | **Changé.** La v2.0 §12 dit elle-même qu'un backtest antérieur à la conception valide l'implémentation, pas la stratégie. Les deux affirmations se contredisent. La sortie de phase 0 devient purement technique. |

## Criteres d'acceptation

**Pureté du noyau**

1. Aucun fichier de `core/` n'importe depuis `adapters/`, `jobs/` ou un module d'IO. Vérifiable par une règle de lint bloquante.
2. Aucun appel à `Date.now()`, `new Date()` sans argument, ni à une source d'aléa dans `core/`. L'horloge est un paramètre.
3. Aucun `number` flottant porteur d'un prix, d'une quantité ou d'un poids dans `core/`. Tous en `decimal.js`.

**Calcul de poids**

4. Property test : sur des soldes et prix aléatoires, la somme des poids vaut 1 à 1e-8 près.
5. Un portefeuille de valeur totale nulle ne provoque ni division par zéro ni `NaN` : il produit un rejet explicite.

**Déclencheur A**

6. A ne tire pas quand le poids USDC est dans `[0.24, 0.36]`, bornes incluses. Test aux bornes exactes.
7. A tire à 0.2399 et à 0.3601.
8. Symétrie : après application des jambes produites par `decide()` en mode `target`, les poids recalculés égalent la cible à 1e-8 près.
9. En mode `band_edge`, les poids recalculés égalent la bande franchie, pas la cible.

**Déclencheur B et son interaction avec A**

10. Quand A et B sont tous deux hors bande, le `trigger` retourné est `CASH_BAND` et aucune jambe BTC↔ETH séparée n'est produite.
11. B n'est évalué que lorsque A est dans sa bande. Test du cas A dedans / B dehors.
12. B respecte un cooldown propre de 7 jours, indépendant de celui de A : deux tirs de B à 6 jours d'intervalle sont refusés, à 7 jours acceptés.
13. Sur la configuration `rebalance` (production), B ne produit **jamais** de jambe, quel que soit le ratio. Sur `rebalance_ab`, il en produit.

**Couche risque**

14. `core/risk.ts` : couverture 100 % en lignes **et en branches**, seuil bloquant dans la configuration Vitest.
15. Un test par code de rejet, les 9 : `ASSET_NOT_ALLOWED`, `QUOTE_NOT_ALLOWED`, `MAX_EXPOSURE`, `MIN_CASH`, `REBALANCE_TOO_LARGE`, `LEG_TOO_SMALL`, `COOLDOWN`, `PRICE_SANITY`, `RECONCILIATION_DRIFT`.
16. `MIN_CASH` évalue l'**état projeté après application des jambes**, pas l'état courant. Un portefeuille dont le cash a naturellement dérivé à 20 % n'est pas rejeté ; une intention dont l'état projeté laisse le cash à 21 % l'est.
17. `MIN_CASH` à 22 % laisse passer un rééquilibrage en mode `band_edge` qui ramène le cash à 24 %.
18. `QUOTE_NOT_ALLOWED` rejette toute paire dont la devise de cotation n'est pas USDC, `*-EUR` en particulier.
19. `LEG_TOO_SMALL` ignore la jambe sous 200 USDC sans rejeter le run entier ; les autres jambes passent.
20. `REBALANCE_TOO_LARGE` rejette quand la somme des valeurs absolues des jambes dépasse 25 % de la valeur totale.
21. `COOLDOWN` ne bloque pas un run qui suit une exécution partielle : seul un rééquilibrage complet réussi arme le compteur.
22. Aucune fonction de `risk.ts` n'expose de paramètre de contournement, de drapeau `dryRun` ou d'option `force`. Vérifiable par inspection de la signature publique.

**Idempotence et identifiants**

23. Deux appels de `decide()` sur le même état et la même horloge produisent des jambes identiques, dans le même ordre.
24. `client_order_id` est stable pour un `(run_date, asset, side, leg_index)` donné et diffère si l'un des quatre change.

**Apports et performance**

25. Un `cash_flow` positif à J gèle le déclencheur A jusqu'à J+7 exclu ; le run de J+7 n'est plus gelé.
26. Le gel de A ne gèle pas B.
27. Un apport sur un portefeuille dont les prix n'ont pas bougé donne un TWR de 0.
28. Max drawdown et Sharpe 90 j sont testés sur une série construite dont la réponse est connue à la main.

**Rejeu historique**

29. Le harnais tourne sur la fixture 2024-01-01 → 2026-08-31 et produit un tableau des 4 stratégies plus les 2 benchmarks hold, avec valeur finale, TWR, Sharpe 90 j, max drawdown, nombre de déclenchements.
30. Le rejeu est déterministe : deux exécutions sur la même fixture produisent une sortie identique octet pour octet.
31. Le test vérifie que le rapport est **produit et déterministe**. Il ne vérifie **pas** qu'une stratégie en bat une autre. Aucun seuil de performance n'est un critère de succès.

**Structurel**

32. Aucun ordre ne peut être passé en phase 0 : il n'existe aucun adapter d'exécution dans le dépôt. Vérifiable par absence de `adapters/`.

## Zones d'incertitude assumees

- **Le rejeu ne valide pas la stratégie.** Les bandes ont été choisies en connaissant grossièrement l'historique 2024-2026 ; les rejouer dessus mesure surtout ce biais. Seul un forward test compte, et la phase 0 n'y contribue pas.
- **La fixture de bougies n'est pas auditée.** Source, fuseau de clôture et traitement des trous ne sont pas spécifiés. Deux sources différentes donneront des résultats de rejeu différents sans qu'il s'agisse d'un bug. À figer au moment de créer la fixture.
- **Le seuil de promotion de B n'est pas fixé.** On saura le mesurer en shadow, on n'a pas dit à partir de quel écart de performance il repasse en production. Décision reportée, à prendre sur données réelles.
- **La méthode de PRU n'est pas tranchée** (moyenne pondérée globale, FIFO, ou méthode du prix total d'acquisition du portefeuille). Exclue de la phase 0 pour cette raison. Doit être décidée avant la phase qui produit l'export fiscal, avec le comptable.
- **`RECONCILIATION_DRIFT` est testé comme prédicat pur**, mais son comportement réel dépend de la fidélité des soldes renvoyés par Coinbase, invérifiable avant la phase 1.
- **La valeur du système reste non démontrée.** La v2.0 §5.6 pose que battre le DCA sur 12 mois est la condition de justification. Rien en phase 0 ne rapproche de cette réponse.
