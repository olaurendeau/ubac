# Plan : ubac-phase-0

Spec de référence : `docs/specs/ubac-phase-0.md`, prioritaire sur la spec générale.
Révision Orca du 2026-09-10. Ce plan regroupe le travail restant ; il ne lance
aucune implémentation et ne change aucun critère métier.

## État et reprise

Constat du 2026-09-10, après reprise sur `origin/main` (`5fad248`) : le `main`
local avait onze commits de retard et la révision précédente de ce plan décrivait
cet état périmé. Les lots ci-dessous sont recalés sur le dépôt distant réel.

Intégrées sur `main` : E1, E2, E3, E4, E5, E6, E10, E11, E12, E13, E15, E17, E18
et E20. `make check` passe (303 tests, `typecheck` inclus).

| Lot | État réel | Reste à livrer |
|---|---|---|
| P1 | acquis | — (E4 PR #10, E5 PR #8 fusionnées) |
| P2 | partiel | E7 état projeté, E8 règles contextuelles, E9 verrou de couverture |
| P3 | partiel | E16 carence de 7 jours sur les apports (C25, C26) |
| P4 | partiel | E14 ladder, PR #12 ouverte ; E15 DCA acquise (PR #13) |
| P5 | acquis | — (E17 PR #15, E18 PR #18 fusionnées) |
| P6 | partiel | E24 script de fixture, PR #14 ouverte ; E21 fixture et intégrité |
| P7 | à faire | E19 idempotence, E22 moteur de rejeu, E23 rapport |

Les anciennes E4–E24 sont remplacées par P1–P7 ci-dessous. Leurs identifiants
restent des références de traçabilité ; ne pas les dispatcher comme tâches
supplémentaires. Les sous-sections détaillées d'un lot ne sont pas des PR. Les
sous-sections déjà intégrées restent écrites ci-dessous à titre de mémoire du
périmètre couvert ; elles ne demandent aucun travail.

Deux PR restent ouvertes et sont reprises, pas recréées : #12 (ladder,
`etape/ubac-phase-0-14`) et #14 (fixture, `etape/ubac-phase-0-24`). Inspecter
leur diff, leurs retours de revue et leur base avant reprise, puis actualiser
titre et description vers le périmètre du lot. Aucune PR ouverte n'est un acquis.
La PR #17 est le témoin du cycle à blanc Orca, hors périmètre métier.
Ne pas supprimer de branches ni élaguer les worktrees pendant la migration.

## Convention de livraison

Une PR par lot, jusqu'à 1 000 lignes ajoutées + supprimées, tests et documentation
compris. Les estimations ci-dessous incluent une marge sur les anciennes étapes.
Compter le diff final contre la base, y compris le travail repris. Fixtures
générées et lockfiles sont exclus du plafond, avec volume et intégrité documentés.
Si une estimation est dépassée, garder le résultat cohérent ; au-delà du plafond,
le coordinateur redécoupe avant de poursuivre la livraison.

Chaque lot exécute ses commandes détaillées, `npm run typecheck` et `npm test`.
P2 exécute en plus `npm run test:coverage` avec seuil bloquant de 100 % lignes et
branches sur `src/core/risk.ts` uniquement. Une dépendance est satisfaite après
merge vérifié par Orca. Les fichiers ci-dessous sont prévisionnels ; le worker
documente les ajustements techniques et les signale pour éviter les collisions.

## Lots

### P1 — Portefeuille et identifiants

- **Acquis** : E4 (PR #10) et E5 (PR #8) sont fusionnées. Rien à dispatcher.
- Remplace : E4, E5.
- Dépend de : E1–E3 intégrées.
- Diff estimé compté : ~300 lignes.
- Couvre : C4, C5, C24.
- Reprise : aucune.
- Fichiers prévus : `src/core/portfolio.ts`, `test/core/portfolio.test.ts`, `src/core/order-id.ts`, `test/core/order-id.test.ts`.

Détails et validations conservés des anciennes étapes :

#### `core/portfolio.ts` (ancienne E4)

- Contenu : poids par actif, valeur totale en USDC, exposition par actif.
- Couvre : C4 (somme des poids = 1 a 1e-8 pres, property test), C5 (valeur totale nulle -> rejet explicite, ni `NaN` ni division par zero).
- Critere de validation : `npx vitest run test/core/portfolio.test.ts` passe, property test `fast-check` inclus sur au moins 1000 tirages.
- Piege connu : `Decimal.div` arrondit a 20 chiffres significatifs par defaut. Sur trois actifs la somme des poids peut manquer 1 de quelques ulps : la tolerance de 1e-8 demandee par C4 absorbe cela, mais une assertion d'egalite stricte echouerait. Ne pas "corriger" en normalisant le dernier poids, cela masquerait un vrai bug de calcul.

#### `core/order-id.ts` (ancienne E5)

- Contenu : `client_order_id` deterministe a partir de `(run_date, asset, side, leg_index)`.
- Couvre : C24 (stabilite pour un quadruplet donne, divergence des qu'un des quatre change).
- Critere de validation : `npx vitest run test/core/order-id.test.ts` passe, avec quatre tests de divergence, un par composante.
- Piege connu : conflit direct avec E2. `node:crypto` est un builtin Node ; si la regle de purete de `core/` bannit tous les imports non relatifs, elle bannit aussi `node:crypto`. Trancher a E2 : autoriser explicitement `node:crypto` en liste blanche. Ce n'est pas de l'IO, mais la regle ne le sait pas.

### P2 — Risque complet et couverture bloquante

- **Reste** : E7 (état projeté), E8 (règles contextuelles), E9 (verrou de couverture et test de contrat). E6 est acquise (PR #9) : `src/core/risk.ts` contient déjà `validate()` et les règles par jambe, à étendre sans les réécrire.
- Remplace : E6, E7, E8, E9.
- Dépend de : P1.
- Diff estimé compté : ~800 lignes.
- Couvre : C14–C22.
- Reprise : aucune.
- Fichiers prévus : `src/core/risk.ts`, `test/core/risk-leg.test.ts`, `test/core/risk-state.test.ts`, `test/core/risk-context.test.ts`, `vitest.config.ts`, `test/core/risk-contract.test.ts`.

Détails et validations conservés des anciennes étapes :

#### `core/risk.ts` : regles par jambe (ancienne E6)

- Contenu : structure de `validate()`, puis `ASSET_NOT_ALLOWED`, `QUOTE_NOT_ALLOWED`, `LEG_TOO_SMALL`.
- Couvre : C18 (toute paire non cotee en USDC rejetee, `*-EUR` en particulier), C19 (jambe sous 200 USDC ignoree sans rejeter le run).
- Critere de validation : `npx vitest run test/core/risk-leg.test.ts` passe. Un test verifie qu'une intention a trois jambes dont une sous le seuil produit deux ordres et zero rejet global.
- Piege connu : `LEG_TOO_SMALL` n'est pas un rejet, c'est un filtre. Le confondre avec les autres codes fait echouer tout un reequilibrage a cause d'une jambe residuelle de 12 USDC. C'est la difference entre "ignoree" et "rejetee" dans C19.

#### `core/risk.ts` : regles sur l'etat projete (ancienne E7)

- Contenu : `MAX_EXPOSURE` (50 %), `MIN_CASH` (22 %), `REBALANCE_TOO_LARGE` (25 %).
- Couvre : C16 (`MIN_CASH` evalue l'etat projete apres application des jambes, pas l'etat courant), C17 (un retour a 24 % en mode `band_edge` passe), C20 (somme des valeurs absolues des jambes > 25 % de la valeur totale -> rejet).
- Critere de validation : `npx vitest run test/core/risk-state.test.ts` passe, avec le couple de tests exige par C16 : cash courant a 20 % non rejete, etat projete a 21 % rejete.
- Piege connu : c'est le point ou le cadrage a change un parametre. `MIN_CASH` etait mort a 15 %, il mord a 22 %. Le test C17 a 24 % est a deux points du seuil : toute erreur de signe ou de base (pourcentage contre fraction) se voit immediatement. Le garder comme test de non-regression sur la valeur du seuil.

#### `core/risk.ts` : regles contextuelles (ancienne E8)

- Contenu : `COOLDOWN`, `PRICE_SANITY`, `RECONCILIATION_DRIFT`.
- Couvre : C21 (le cooldown n'est arme que par un reequilibrage complet reussi ; un run suivant une execution partielle n'est pas bloque).
- Critere de validation : `npx vitest run test/core/risk-context.test.ts` passe. Test explicite : reequilibrage complet a J arme le compteur, execution partielle a J n'arme rien et le run de J+1 est accepte.
- Piege connu : `RECONCILIATION_DRIFT` est un predicat pur ici, mais il n'aura de sens qu'en phase 1 face aux vrais soldes Coinbase. Ne pas sur-tester la forme et se croire couvert : la spec l'assume comme incertitude.

#### Verrou de couverture et absence de contournement (ancienne E9)

- Couvre : C14 (couverture 100 % lignes et branches sur `risk.ts`, seuil bloquant), C15 (un test par code de rejet, les 9), C22 (aucun parametre de contournement dans la signature publique).
- Critere de validation : `npx vitest run --coverage` sort en 0 et sort en 1 si une branche de `risk.ts` est retiree de la couverture. Le test de contrat assert que les 9 codes de rejet sont chacun atteints au moins une fois sur la campagne, et que le source de `risk.ts` ne contient aucune des chaines `dryRun`, `force`, `bypass`, `skipValidation`.
- Piege connu : un seuil de couverture global a 100 % bloquerait tout le depot, ce que la spec ne demande pas. Le seuil doit etre declare par glob sur `src/core/risk.ts` seul. Le controle d'absence de contournement par recherche de chaines est grossier et contournable ; il vaut comme garde-fou, pas comme preuve. Le dire dans la PR plutot que de le vendre comme une garantie.

### P3 — Rééquilibrage, modes et carence

- **Reste** : E16 seule (carence de 7 jours, C25 et C26). E10, E11, E12 et E13 sont acquises (PR #11, #16, #19, #20) ; `src/core/strategy/rebalance.ts` et `src/core/config.ts` existent et sont à étendre, pas à réécrire. Diff attendu bien sous l'estimation initiale.
- Remplace : E10, E11, E12, E13, E16.
- Dépend de : P1.
- Diff estimé compté : ~900 lignes.
- Couvre : C6–C13, C25, C26.
- Reprise : aucune.
- Fichiers prévus : `src/core/strategy/rebalance.ts`, `test/core/rebalance-a.test.ts`, `test/core/rebalance-band-edge.test.ts`, `src/core/config.ts`, `test/core/rebalance-b.test.ts`, `test/core/rebalance-ab.test.ts`, `test/core/cash-flow-delay.test.ts`.

Détails et validations conservés des anciennes étapes :

#### `rebalance.ts` : declencheur A, mode `target` (ancienne E10)

- Contenu : detection de la bande cash, calcul des jambes, retour a la cible exacte.
- Couvre : C6 (pas de tir dans `[0.24, 0.36]`, bornes incluses), C7 (tir a 0.2399 et a 0.3601), C8 (symetrie : poids recalcules apres application des jambes = cible a 1e-8 pres).
- Critere de validation : `npx vitest run test/core/rebalance-a.test.ts` passe, avec les quatre tests de borne exacte exiges par C6 et C7.
- Piege connu : les comparaisons de bornes doivent utiliser `Decimal.lt` et `Decimal.gt`, jamais `<` et `>` sur des objets. Une comparaison d'objets en JavaScript passe par la coercition et donnera des resultats faux mais plausibles, exactement aux bornes que C6 teste.

#### `rebalance.ts` : mode `band_edge` (ancienne E11)

- Couvre : C9 (les poids recalcules egalent la bande franchie, pas la cible).
- Critere de validation : `npx vitest run test/core/rebalance-band-edge.test.ts` passe, avec un test par sens de franchissement.
- Piege connu : le retour se fait au bord **franchi**, pas a un bord fixe. Cash a 20 % remonte a 24 %, cash a 40 % redescend a 36 %. Ramener systematiquement a 24 % est l'erreur naturelle et elle ne se voit que sur le sens haut.

#### `rebalance.ts` : declencheur B et son drapeau (ancienne E12)

- Contenu : bande ratio BTC/ETH, jambes BTC<->ETH a cash constant, drapeau `ratioBandEnabled`.
- Couvre : C13 (sur la configuration `rebalance`, B ne produit jamais de jambe quel que soit le ratio ; sur `rebalance_ab`, il en produit).
- Critere de validation : `npx vitest run test/core/rebalance-b.test.ts` passe. Un test balaye des ratios de 0.5 a 3.0 sous la configuration `rebalance` et exige zero jambe sur toute la plage.
- Piege connu : `ratioBandEnabled` doit valoir `false` par defaut. Un defaut a `true` fait passer B en production par omission, ce que le cadrage a explicitement refuse. Le test de balayage de C13 est la seule chose qui rattrape cette erreur.

#### `rebalance.ts` : priorite A sur B et cooldown propre a B (ancienne E13)

- Couvre : C10 (A et B hors bande -> `trigger` vaut `CASH_BAND` et aucune jambe BTC<->ETH separee), C11 (B evalue seulement si A est dans sa bande), C12 (cooldown de B independant : refus a 6 jours, acceptation a 7).
- Critere de validation : `npx vitest run test/core/rebalance-ab.test.ts` passe, les trois criteres ayant chacun leur test nomme.
- Piege connu : l'erreur naturelle est de calculer les jambes de B puis de les jeter quand A tire, en laissant `trigger` a `RATIO_BAND`. Le champ `trigger` est journalise dans `decisions` et sert a compter les declenchements dans le rejeu : une valeur fausse fausse la comparaison des strategies sans qu'aucun test de jambe ne bronche.

#### Carence de 7 jours sur les apports (ancienne E16)

- Couvre : C25 (un `cash_flow` positif a J gele A jusqu'a J+7 exclu, le run de J+7 n'est plus gele), C26 (le gel de A ne gele pas B).
- Critere de validation : `npx vitest run test/core/cash-flow-delay.test.ts` passe, avec un test a J+6 gele et un test a J+7 non gele.
- Piege connu : la borne de C25 est exclusive. Un `<=` a la place d'un `<` decale le degel d'un jour et le seul test qui le voit est celui de J+7. Un retrait (montant negatif) ne gele rien : C25 ne parle que d'un apport positif.

### P4 — Stratégies shadow

- **Reste** : E14 seule (ladder), sur la PR #12 existante. E15 (DCA) est acquise (PR #13) et sa règle de repli est déjà tranchée dans le code ; la gate DCA est sans objet.
- Remplace : E14, E15.
- Dépend de : P1.
- Diff estimé compté : ~400 lignes.
- Couvre : C23 préparé, vérifié avec les quatre configurations en P7.
- Reprise : PR #12, branche etape/ubac-phase-0-14.
- Fichiers prévus : `src/core/strategy/ladder.ts`, `test/core/ladder.test.ts`, `src/core/strategy/dca.ts`, `test/core/dca.test.ts`.
- Décision préalable : faire confirmer la règle de repli DCA pour un jour absent du mois via une gate Orca avant implémentation.

Détails et validations conservés des anciennes étapes :

#### `core/strategy/ladder.ts` (shadow) (ancienne E14)

- Contenu : ancre unique, achat a -7 % BTC / -9 % ETH, vente a +12 % / +15 %, tranches de 500 USDC.
- Critere de validation : `npx vitest run test/core/ladder.test.ts` passe.
- Piege connu : la spec ne dit pas comment l'ancre est initialisee au premier jour du rejeu. Choisir le prix de cloture du premier jour, le documenter dans la PR, et ne pas laisser ce choix implicite : il decale toute la serie de resultats du ladder shadow.

#### `core/strategy/dca.ts` (shadow) (ancienne E15)

- Contenu : montant fixe a date fixe.
- Critere de validation : `npx vitest run test/core/dca.test.ts` passe.
- Piege connu : une date d'achat fixee au 29, 30 ou 31 n'existe pas tous les mois. Faire trancher la regle de repli dans la gate du lot, puis la tester sur fevrier.

### P5 — Benchmarks

- **Acquis** : E17 (PR #15) et E18 (PR #18) sont fusionnées. Rien à dispatcher ; la gate sur la convention de flux est close par le code intégré.
- Remplace : E17, E18.
- Dépend de : P1.
- Diff estimé compté : ~450 lignes.
- Couvre : C27, C28.
- Reprise : PR #15, branche etape/ubac-phase-0-17.
- Fichiers prévus : `src/core/benchmark.ts`, `test/core/benchmark-twr.test.ts`, `test/core/benchmark-risk.test.ts`.
- Décision préalable : faire confirmer la convention flux/valorisation intrajournalière via une gate Orca, en tenant compte du choix proposé dans la PR #15.

Détails et validations conservés des anciennes étapes :

#### `core/benchmark.ts` : hold et TWR (ancienne E17)

- Contenu : hold BTC, hold 50/50, time-weighted return.
- Couvre : C27 (un apport sur un portefeuille a prix constants donne un TWR de 0).
- Critere de validation : `npx vitest run test/core/benchmark-twr.test.ts` passe, dont le test exact de C27.
- Piege connu : le TWR se decoupe en sous-periodes bornees par chaque flux. Un apport et une variation de prix le meme jour exigent de fixer une convention d'ordre (flux avant ou apres la valorisation) ; les deux conventions donnent des chiffres differents et la spec ne tranche pas. Faire confirmer la convention dans la gate du lot, la documenter et la tester.

#### `core/benchmark.ts` : Sharpe 90 j et max drawdown (ancienne E18)

- Couvre : C28 (series construites dont la reponse est connue a la main).
- Critere de validation : `npx vitest run test/core/benchmark-risk.test.ts` passe, sur au moins une serie monotone et une serie en V dont le drawdown est calculable de tete.
- Piege connu : le Sharpe glissant 90 jours n'est pas defini sur les 89 premiers jours. Retourner `null`, pas `0` : un zero se propage dans le tableau de rejeu et se lit comme une performance neutre reelle.

### P6 — Préparation et intégrité des fixtures

- **Reste** : E24 (script de téléchargement, PR #14 ouverte) et E21 (fixture de bougies et de flux, test d'intégrité). E20 est acquise (PR #7) : `src/fixture/normalise.ts` existe. La gate porte sur la source, le fuseau de clôture et la politique de trous proposés par `docs/fixture-source.md` dans la PR #14.
- Remplace : E20, E24, E21.
- Dépend de : E1–E3 intégrées.
- Diff estimé compté : ~650 lignes.
- Couvre : C29 préparé, intégration en P7.
- Reprise : PR #14, branche etape/ubac-phase-0-24.
- Fichiers prévus : `src/fixture/normalise.ts`, `test/fixture/normalise.test.ts`, `scripts/build-fixture.ts`, `docs/fixture-source.md`, `package.json`, `test/fixtures/candles-btc-usdc.csv`, `test/fixtures/candles-eth-usdc.csv`, `test/fixtures/cash-flows.json`, `test/fixtures/integrity.test.ts`.
- Généré exclu : ~1 950 lignes de bougies CSV ; lockfile si dépendances ajoutées. Les tests et la note de source restent comptés.
- Décision préalable : faire confirmer la source des bougies, le fuseau de clôture et la politique de trous via une gate Orca ; examiner la proposition de la PR #14.

Détails et validations conservés des anciennes étapes :

#### Normalisation des bougies, pure (ancienne E20)

- Contenu : les predicats et la normalisation, sans reseau ni acces disque. Alignement des horodatages sur 00:00 UTC, detection de jour manquant, refus d'un prix nul ou negatif, detection de doublon contradictoire. Fonctions exportees, prenant des bougies deja en memoire.
- Critere de validation : `npx vitest run test/fixture/normalise.test.ts` passe, avec un test par cause de refus : horodatage non multiple de 86 400 s, jour manquant dans la serie, prix nul ou negatif, deux lignes du meme jour aux valeurs differentes.
- Piege connu : c'est l'etape qui repond a l'incertitude "fixture non auditee" de la spec. Les bougies daily crypto cloturent a 00:00 UTC ; une source qui cloture en heure locale decale toute la serie et change les resultats du rejeu sans qu'aucun test n'echoue. Ce controle ne vaut que s'il est atteignable depuis un test : la premiere tentative l'avait enfoui dans un script sans export, ou il etait affirme en commentaire et verifiable par personne. Le module vit hors de `src/core/`, donc la regle de purete d'E2 ne le protege pas ; le garder sans IO est une discipline, pas une contrainte outillee.

#### Telechargement de la fixture et note de source (ancienne E24)

- Contenu : le script qui telecharge les bougies, delegue tout controle a `src/fixture/normalise.ts` et ecrit les CSV. La note fige la source, le fuseau de cloture et la politique de trous. `package.json` gagne `tsx` en dependance de developpement.
- Critere de validation : `npx tsx scripts/build-fixture.ts --dry-run` sort en 0, affiche le nombre de jours attendus, et le statut Git apres execution est identique au statut initial (aucun fichier cree ou modifie par le dry-run). `docs/fixture-source.md` existe et nomme explicitement la source, le fuseau et la regle de trou.
- Piege connu : l'ecriture doit etre tout ou rien. La premiere tentative ecrivait le CSV de BTC avant de telecharger ETH : un echec sur ETH laissait une fixture a moitie regeneree sur le disque pendant que le script affichait "aucun fichier ecrit". Telecharger les deux actifs, tout valider, puis ecrire seulement a la fin, via des fichiers temporaires renommes. La regle d'idempotence de `AGENTS.md` n'est pas negociable et c'est ici qu'elle se joue.
- Piege connu, deuxieme : `tsx` n'etait dans aucune dependance alors que le critere de validation l'invoque. Sans l'ajout a `package.json`, l'etape ne peut pas prouver son propre critere.

#### Fixture de bougies et de flux, avec test d'integrite (ancienne E21)

- Contenu : bougies daily du 2024-01-01 au 2026-08-31 pour BTC et ETH, plus les flux de tresorerie du rejeu.
- Critere de validation : `npx vitest run test/fixtures/integrity.test.ts` passe. Le test verifie le nombre exact de lignes, l'absence de jour manquant, la monotonie des dates, l'absence de prix nul ou negatif, et une empreinte SHA-256 figee par fichier.
- Piege connu : etape dont le diff est illisible sur telephone par nature. La relecture doit porter sur le test d'integrite et sur l'empreinte, pas sur les lignes. Corollaire : toute regeneration ulterieure de la fixture change l'empreinte et doit etre une PR consciente, jamais un effet de bord.

### P7 — Idempotence, rejeu et rapport

- Remplace : E19, E22, E23.
- Dépend de : P2, P3, P4, P5, P6.
- Diff estimé compté : ~550 lignes.
- Couvre : C23, C29–C31.
- Reprise : aucune.
- Fichiers prévus : `test/core/idempotence.test.ts`, `src/replay/engine.ts`, `test/replay/engine.test.ts`, `src/replay/report.ts`, `test/replay/report.test.ts`, `package.json`.

Détails et validations conservés des anciennes étapes :

#### Idempotence de `decide()` (ancienne E19)

- Contenu : tests seuls, aucune source modifiee.
- Couvre : C23 (deux appels sur le meme etat et la meme horloge produisent des jambes identiques, dans le meme ordre).
- Critere de validation : `npx vitest run test/core/idempotence.test.ts` passe sur les quatre configurations de strategie.
- Piege connu : C23 exige l'identite de l'**ordre** des jambes, pas seulement de leur ensemble. Un parcours par `Object.keys` sur un objet de poids est stable en pratique mais pas garanti par contrat pour toutes les formes de cles. Trier explicitement.

#### Moteur de rejeu (ancienne E22)

- Contenu : deroule les 4 configurations de strategie et les 2 benchmarks hold sur la fixture, avec horloge injectee, et retourne un resultat structure.
- Couvre : C29, partiellement (production des metriques par strategie).
- Critere de validation : `npx vitest run test/replay/engine.test.ts` passe et assert que le resultat contient les 6 series attendues, chacune avec valeur finale, TWR, Sharpe 90 j, max drawdown et nombre de declenchements.
- Piege connu : le moteur vit hors de `core/`, donc la regle de purete d'E2 ne le protege pas. C'est precisement la ou une lecture de l'horloge systeme se glisse et rend le rejeu non reproductible. L'horloge doit venir de la fixture, ligne par ligne.

#### Rendu du tableau comparatif et determinisme (ancienne E23)

- Contenu : rendu texte du tableau, script `npm run replay`.
- Couvre : C29 (tableau complet), C30 (deux executions produisent une sortie identique octet pour octet), C31 (le test verifie la production et le determinisme, jamais qu'une strategie en bat une autre).
- Critere de validation : `npm run replay > a.txt && npm run replay > b.txt && cmp a.txt b.txt` sort en 0. `npx vitest run test/replay/report.test.ts` passe.
- Piege connu : C31 est une interdiction, pas une omission. Aucune assertion du type "rebalance > dca" ne doit entrer dans ce fichier de test, meme si le rejeu la rend vraie : ce serait figer en test un resultat que la spec refuse explicitement de valider. Cote determinisme, les pieges sont le formatage de nombres dependant de la locale et tout parcours de `Map` ou `Set` non trie.

## Couverture exhaustive de la spec

| Critères | Acquis ou lot responsable |
|---|---|
| C1, C2, C32 | E2 acquise ; garde-fous exécutés dans chaque lot |
| C3 | E3 acquise ; typecheck exécuté dans chaque lot |
| C4, C5, C24 | P1 |
| C6, C7, C8, C9, C10, C11, C12, C13, C25, C26 | P3 |
| C14, C15, C16, C17, C18, C19, C20, C21, C22 | P2 |
| C23 | P7, sur les stratégies de P3 et P4 |
| C27, C28 | P5 |
| C29, C30, C31 | P7, avec la fixture contrôlée de P6 |

## Ordre et concurrence

- P1 et P5 sont acquis ; ils ne sont plus dispatchés.
- Éligibles immédiatement, sans dépendance entre eux : P2 (reste), P3 (reste)
  et P4 (reste). P6 est éligible dès que sa gate est résolue.
- P2 et P3 touchent des fichiers disjoints (`risk.ts` contre `rebalance.ts`) et
  peuvent être menés en parallèle. P4 crée `ladder.ts` sur une branche existante.
- P7 attend l'intégration de P2, P3, P4 et P6.

Trois workers simultanés maximum, construction et revue comprises. Les fichiers
partagés ajoutés en cours de travail, notamment `package.json`, les types et la
configuration, restent à sérialiser par le coordinateur ; l'isolation Git ne
supprime pas les conflits d'intégration.

Cinq lots restants (P2, P3, P4, P6, P7), dont deux repris sur PR ouverte. La fixture ne nécessite pas
d'exception de taille : ses données générées sont contrôlées séparément. Aucune
estimation en « une soirée » ; mesurer les temps réels pendant les cycles Orca.
