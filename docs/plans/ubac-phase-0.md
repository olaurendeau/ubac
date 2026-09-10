# Plan : ubac-phase-0

Spec de reference : docs/specs/ubac-phase-0.md

Etat de depart : depot vide de code. Pas de `package.json`, pas de `src/`. Tout part de zero.

Convention de validation : chaque critere note `C<n>` renvoie a la liste "Criteres d'acceptation" de la spec.

Revision du 2026-09-10, apres blocage de E3 et E20 par le relecteur. E3 gagne une marque distincte pour les montants en USDC. E20 est scindee : la normalisation pure et ses tests restent en E20, le telechargement et l'ecriture passent en **E24**, dont E21 depend desormais. Aucune correction ne touche la spec.

## Etapes

### E1 - Squelette Node / TypeScript / Vitest
- Depend de : aucune
- Diff estime : ~90 lignes
- Fichiers touches : `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Contenu : Node 22, ESM, TypeScript strict. Dependances : `decimal.js`. Dev : `typescript`, `vitest`, `@vitest/coverage-v8`, `fast-check`, `eslint`, `typescript-eslint`.
- Critere de validation : `npm ci` puis `npx tsc --noEmit` sortent en 0, et `npx vitest run --passWithNoTests` sort en 0.
- Piege connu : `"type": "module"` avec un `moduleResolution` en `node10` casse silencieusement les imports d'extension `.js`. Utiliser `NodeNext`. Vitest sort en 1 quand aucun test n'existe : le drapeau `--passWithNoTests` n'est valable que pour cette etape.

### E2 - Garde-fous structurels de la phase 0
- Depend de : E1
- Diff estime : ~110 lignes
- Fichiers touches : `eslint.config.js`, `test/structure.test.ts`, `test/lint/fixtures/*`
- Couvre : C1 (aucun import de `adapters/` ou `jobs/` depuis `core/`), C2 (aucun `Date.now()`, `new Date()` sans argument, `Math.random()` dans `core/`), C32 (aucun repertoire `adapters/` ni `jobs/`).
- Critere de validation : `npx vitest run test/structure.test.ts` passe. Le test lance l'API ESLint sur trois fixtures volontairement fautives et exige exactement les identifiants de regle attendus, puis assert que `src/adapters` et `src/jobs` n'existent pas.
- Piege connu : une regle qui interdit `Date.now()` globalement casse les tests et le harnais de rejeu, qui manipulent legitimement des dates. Restreindre la regle au glob `src/core/**`. Les fixtures fautives doivent etre exclues de `tsconfig.json`, sinon `tsc --noEmit` echoue.

### E3 - `core/types.ts`
- Depend de : E1
- Diff estime : ~150 lignes
- Fichiers touches : `src/core/types.ts`, `test/core/types.test-d.ts`
- Contenu : `Price`, `Quantity`, `UsdcAmount`, `Weight`, `Intent`, `Order`, `Rejection`, `Verdict`, `Weights`, `Candle`, `CashFlow`, `Clock`. Declarations de types uniquement, aucune logique. Quatre marques, pas trois : un prix est un nombre d'USDC **par unite d'actif**, une quantite est un nombre d'unites d'actif, un `UsdcAmount` est un nombre d'USDC. La relation dimensionnelle est `UsdcAmount = Price x Quantity`.
- Couvre : C3 (aucun `number` flottant porteur d'un prix, d'une quantite ou d'un poids). Sert aussi C19 et C20, qui raisonnent sur des montants en USDC et non sur des quantites.
- Critere de validation : `npx tsc --noEmit` sort en 0. Le fichier `types.test-d.ts` contient une ligne `// @ts-expect-error` par confusion interdite : un `number` affecte a chacune des quatre marques, un `UsdcAmount` affecte a une `Quantity`, une `Quantity` affectee a un `UsdcAmount`, un `Price` affecte a un `UsdcAmount`. Si une marque s'effondre sur une autre, `tsc` echoue sur l'attente non satisfaite.
- Piege connu : `type Price = Decimal` ne protege de rien entre `Price` et `Quantity` : le typage structurel les rend interchangeables. Il faut des types marques (`Decimal & { readonly __brand: 'Price' }`) pour que C3 ait un sens au-dela du simple bannissement de `number`. Choisir maintenant, pas apres que dix modules aient ete ecrits.
- Piege connu, deuxieme : la premiere tentative de cette etape a donne la meme marque `Quantity` au montant en USDC d'une jambe et a la quantite d'actif d'un ordre. Les deux sont des `Decimal` positifs, la confusion est naturelle, et elle rend **compilable** une conversion intention vers ordre qui oublie la division par le prix limite. L'ordre part alors plusieurs ordres de grandeur trop gros. C'est exactement le bug que le typage marque est cense rendre impossible : si les quatre marques ne sont pas distinctes, l'etape ne sert a rien.

### E4 - `core/portfolio.ts`
- Depend de : E3
- Diff estime : ~150 lignes
- Fichiers touches : `src/core/portfolio.ts`, `test/core/portfolio.test.ts`
- Contenu : poids par actif, valeur totale en USDC, exposition par actif.
- Couvre : C4 (somme des poids = 1 a 1e-8 pres, property test), C5 (valeur totale nulle -> rejet explicite, ni `NaN` ni division par zero).
- Critere de validation : `npx vitest run test/core/portfolio.test.ts` passe, property test `fast-check` inclus sur au moins 1000 tirages.
- Piege connu : `Decimal.div` arrondit a 20 chiffres significatifs par defaut. Sur trois actifs la somme des poids peut manquer 1 de quelques ulps : la tolerance de 1e-8 demandee par C4 absorbe cela, mais une assertion d'egalite stricte echouerait. Ne pas "corriger" en normalisant le dernier poids, cela masquerait un vrai bug de calcul.

### E5 - `core/order-id.ts`
- Depend de : E3
- Diff estime : ~70 lignes
- Fichiers touches : `src/core/order-id.ts`, `test/core/order-id.test.ts`
- Contenu : `client_order_id` deterministe a partir de `(run_date, asset, side, leg_index)`.
- Couvre : C24 (stabilite pour un quadruplet donne, divergence des qu'un des quatre change).
- Critere de validation : `npx vitest run test/core/order-id.test.ts` passe, avec quatre tests de divergence, un par composante.
- Piege connu : conflit direct avec E2. `node:crypto` est un builtin Node ; si la regle de purete de `core/` bannit tous les imports non relatifs, elle bannit aussi `node:crypto`. Trancher a E2 : autoriser explicitement `node:crypto` en liste blanche. Ce n'est pas de l'IO, mais la regle ne le sait pas.

### E6 - `core/risk.ts` : regles par jambe
- Depend de : E3
- Diff estime : ~140 lignes
- Fichiers touches : `src/core/risk.ts`, `test/core/risk-leg.test.ts`
- Contenu : structure de `validate()`, puis `ASSET_NOT_ALLOWED`, `QUOTE_NOT_ALLOWED`, `LEG_TOO_SMALL`.
- Couvre : C18 (toute paire non cotee en USDC rejetee, `*-EUR` en particulier), C19 (jambe sous 200 USDC ignoree sans rejeter le run).
- Critere de validation : `npx vitest run test/core/risk-leg.test.ts` passe. Un test verifie qu'une intention a trois jambes dont une sous le seuil produit deux ordres et zero rejet global.
- Piege connu : `LEG_TOO_SMALL` n'est pas un rejet, c'est un filtre. Le confondre avec les autres codes fait echouer tout un reequilibrage a cause d'une jambe residuelle de 12 USDC. C'est la difference entre "ignoree" et "rejetee" dans C19.

### E7 - `core/risk.ts` : regles sur l'etat projete
- Depend de : E4, E6
- Diff estime : ~160 lignes
- Fichiers touches : `src/core/risk.ts`, `test/core/risk-state.test.ts`
- Contenu : `MAX_EXPOSURE` (50 %), `MIN_CASH` (22 %), `REBALANCE_TOO_LARGE` (25 %).
- Couvre : C16 (`MIN_CASH` evalue l'etat projete apres application des jambes, pas l'etat courant), C17 (un retour a 24 % en mode `band_edge` passe), C20 (somme des valeurs absolues des jambes > 25 % de la valeur totale -> rejet).
- Critere de validation : `npx vitest run test/core/risk-state.test.ts` passe, avec le couple de tests exige par C16 : cash courant a 20 % non rejete, etat projete a 21 % rejete.
- Piege connu : c'est le point ou le cadrage a change un parametre. `MIN_CASH` etait mort a 15 %, il mord a 22 %. Le test C17 a 24 % est a deux points du seuil : toute erreur de signe ou de base (pourcentage contre fraction) se voit immediatement. Le garder comme test de non-regression sur la valeur du seuil.

### E8 - `core/risk.ts` : regles contextuelles
- Depend de : E6
- Diff estime : ~150 lignes
- Fichiers touches : `src/core/risk.ts`, `test/core/risk-context.test.ts`
- Contenu : `COOLDOWN`, `PRICE_SANITY`, `RECONCILIATION_DRIFT`.
- Couvre : C21 (le cooldown n'est arme que par un reequilibrage complet reussi ; un run suivant une execution partielle n'est pas bloque).
- Critere de validation : `npx vitest run test/core/risk-context.test.ts` passe. Test explicite : reequilibrage complet a J arme le compteur, execution partielle a J n'arme rien et le run de J+1 est accepte.
- Piege connu : `RECONCILIATION_DRIFT` est un predicat pur ici, mais il n'aura de sens qu'en phase 1 face aux vrais soldes Coinbase. Ne pas sur-tester la forme et se croire couvert : la spec l'assume comme incertitude.

### E9 - Verrou de couverture et absence de contournement
- Depend de : E7, E8
- Diff estime : ~60 lignes
- Fichiers touches : `vitest.config.ts`, `test/core/risk-contract.test.ts`
- Couvre : C14 (couverture 100 % lignes et branches sur `risk.ts`, seuil bloquant), C15 (un test par code de rejet, les 9), C22 (aucun parametre de contournement dans la signature publique).
- Critere de validation : `npx vitest run --coverage` sort en 0 et sort en 1 si une branche de `risk.ts` est retiree de la couverture. Le test de contrat assert que les 9 codes de rejet sont chacun atteints au moins une fois sur la campagne, et que le source de `risk.ts` ne contient aucune des chaines `dryRun`, `force`, `bypass`, `skipValidation`.
- Piege connu : un seuil de couverture global a 100 % bloquerait tout le depot, ce que la spec ne demande pas. Le seuil doit etre declare par glob sur `src/core/risk.ts` seul. Le controle d'absence de contournement par recherche de chaines est grossier et contournable ; il vaut comme garde-fou, pas comme preuve. Le dire dans la PR plutot que de le vendre comme une garantie.

### E10 - `rebalance.ts` : declencheur A, mode `target`
- Depend de : E4
- Diff estime : ~170 lignes
- Fichiers touches : `src/core/strategy/rebalance.ts`, `test/core/rebalance-a.test.ts`
- Contenu : detection de la bande cash, calcul des jambes, retour a la cible exacte.
- Couvre : C6 (pas de tir dans `[0.24, 0.36]`, bornes incluses), C7 (tir a 0.2399 et a 0.3601), C8 (symetrie : poids recalcules apres application des jambes = cible a 1e-8 pres).
- Critere de validation : `npx vitest run test/core/rebalance-a.test.ts` passe, avec les quatre tests de borne exacte exiges par C6 et C7.
- Piege connu : les comparaisons de bornes doivent utiliser `Decimal.lt` et `Decimal.gt`, jamais `<` et `>` sur des objets. Une comparaison d'objets en JavaScript passe par la coercition et donnera des resultats faux mais plausibles, exactement aux bornes que C6 teste.

### E11 - `rebalance.ts` : mode `band_edge`
- Depend de : E10
- Diff estime : ~80 lignes
- Fichiers touches : `src/core/strategy/rebalance.ts`, `test/core/rebalance-band-edge.test.ts`
- Couvre : C9 (les poids recalcules egalent la bande franchie, pas la cible).
- Critere de validation : `npx vitest run test/core/rebalance-band-edge.test.ts` passe, avec un test par sens de franchissement.
- Piege connu : le retour se fait au bord **franchi**, pas a un bord fixe. Cash a 20 % remonte a 24 %, cash a 40 % redescend a 36 %. Ramener systematiquement a 24 % est l'erreur naturelle et elle ne se voit que sur le sens haut.

### E12 - `rebalance.ts` : declencheur B et son drapeau
- Depend de : E10
- Diff estime : ~140 lignes
- Fichiers touches : `src/core/strategy/rebalance.ts`, `src/core/config.ts`, `test/core/rebalance-b.test.ts`
- Contenu : bande ratio BTC/ETH, jambes BTC<->ETH a cash constant, drapeau `ratioBandEnabled`.
- Couvre : C13 (sur la configuration `rebalance`, B ne produit jamais de jambe quel que soit le ratio ; sur `rebalance_ab`, il en produit).
- Critere de validation : `npx vitest run test/core/rebalance-b.test.ts` passe. Un test balaye des ratios de 0.5 a 3.0 sous la configuration `rebalance` et exige zero jambe sur toute la plage.
- Piege connu : `ratioBandEnabled` doit valoir `false` par defaut. Un defaut a `true` fait passer B en production par omission, ce que le cadrage a explicitement refuse. Le test de balayage de C13 est la seule chose qui rattrape cette erreur.

### E13 - `rebalance.ts` : priorite A sur B et cooldown propre a B
- Depend de : E11, E12
- Diff estime : ~130 lignes
- Fichiers touches : `src/core/strategy/rebalance.ts`, `test/core/rebalance-ab.test.ts`
- Couvre : C10 (A et B hors bande -> `trigger` vaut `CASH_BAND` et aucune jambe BTC<->ETH separee), C11 (B evalue seulement si A est dans sa bande), C12 (cooldown de B independant : refus a 6 jours, acceptation a 7).
- Critere de validation : `npx vitest run test/core/rebalance-ab.test.ts` passe, les trois criteres ayant chacun leur test nomme.
- Piege connu : l'erreur naturelle est de calculer les jambes de B puis de les jeter quand A tire, en laissant `trigger` a `RATIO_BAND`. Le champ `trigger` est journalise dans `decisions` et sert a compter les declenchements dans le rejeu : une valeur fausse fausse la comparaison des strategies sans qu'aucun test de jambe ne bronche.

### E14 - `core/strategy/ladder.ts` (shadow)
- Depend de : E4
- Diff estime : ~140 lignes
- Fichiers touches : `src/core/strategy/ladder.ts`, `test/core/ladder.test.ts`
- Contenu : ancre unique, achat a -7 % BTC / -9 % ETH, vente a +12 % / +15 %, tranches de 500 USDC.
- Critere de validation : `npx vitest run test/core/ladder.test.ts` passe.
- Piege connu : la spec ne dit pas comment l'ancre est initialisee au premier jour du rejeu. Choisir le prix de cloture du premier jour, le documenter dans la PR, et ne pas laisser ce choix implicite : il decale toute la serie de resultats du ladder shadow.

### E15 - `core/strategy/dca.ts` (shadow)
- Depend de : E4
- Diff estime : ~90 lignes
- Fichiers touches : `src/core/strategy/dca.ts`, `test/core/dca.test.ts`
- Contenu : montant fixe a date fixe.
- Critere de validation : `npx vitest run test/core/dca.test.ts` passe.
- Piege connu : une date d'achat fixee au 29, 30 ou 31 n'existe pas tous les mois. Definir la regle de repli (jour ouvre suivant, ou dernier jour du mois) et la tester sur fevrier.

### E16 - Carence de 7 jours sur les apports
- Depend de : E13
- Diff estime : ~130 lignes
- Fichiers touches : `src/core/strategy/rebalance.ts`, `test/core/cash-flow-delay.test.ts`
- Couvre : C25 (un `cash_flow` positif a J gele A jusqu'a J+7 exclu, le run de J+7 n'est plus gele), C26 (le gel de A ne gele pas B).
- Critere de validation : `npx vitest run test/core/cash-flow-delay.test.ts` passe, avec un test a J+6 gele et un test a J+7 non gele.
- Piege connu : la borne de C25 est exclusive. Un `<=` a la place d'un `<` decale le degel d'un jour et le seul test qui le voit est celui de J+7. Un retrait (montant negatif) ne gele rien : C25 ne parle que d'un apport positif.

### E17 - `core/benchmark.ts` : hold et TWR
- Depend de : E4
- Diff estime : ~150 lignes
- Fichiers touches : `src/core/benchmark.ts`, `test/core/benchmark-twr.test.ts`
- Contenu : hold BTC, hold 50/50, time-weighted return.
- Couvre : C27 (un apport sur un portefeuille a prix constants donne un TWR de 0).
- Critere de validation : `npx vitest run test/core/benchmark-twr.test.ts` passe, dont le test exact de C27.
- Piege connu : le TWR se decoupe en sous-periodes bornees par chaque flux. Un apport et une variation de prix le meme jour exigent de fixer une convention d'ordre (flux avant ou apres la valorisation) ; les deux conventions donnent des chiffres differents et la spec ne tranche pas. Choisir, documenter dans la PR, tester la convention choisie.

### E18 - `core/benchmark.ts` : Sharpe 90 j et max drawdown
- Depend de : E17
- Diff estime : ~130 lignes
- Fichiers touches : `src/core/benchmark.ts`, `test/core/benchmark-risk.test.ts`
- Couvre : C28 (series construites dont la reponse est connue a la main).
- Critere de validation : `npx vitest run test/core/benchmark-risk.test.ts` passe, sur au moins une serie monotone et une serie en V dont le drawdown est calculable de tete.
- Piege connu : le Sharpe glissant 90 jours n'est pas defini sur les 89 premiers jours. Retourner `null`, pas `0` : un zero se propage dans le tableau de rejeu et se lit comme une performance neutre reelle.

### E19 - Idempotence de `decide()`
- Depend de : E13, E14, E15
- Diff estime : ~70 lignes
- Fichiers touches : `test/core/idempotence.test.ts`
- Contenu : tests seuls, aucune source modifiee.
- Couvre : C23 (deux appels sur le meme etat et la meme horloge produisent des jambes identiques, dans le meme ordre).
- Critere de validation : `npx vitest run test/core/idempotence.test.ts` passe sur les quatre configurations de strategie.
- Piege connu : C23 exige l'identite de l'**ordre** des jambes, pas seulement de leur ensemble. Un parcours par `Object.keys` sur un objet de poids est stable en pratique mais pas garanti par contrat pour toutes les formes de cles. Trier explicitement.

### E20 - Normalisation des bougies, pure
- Depend de : E1
- Diff estime : ~140 lignes
- Fichiers touches : `src/fixture/normalise.ts`, `test/fixture/normalise.test.ts`
- Contenu : les predicats et la normalisation, sans reseau ni acces disque. Alignement des horodatages sur 00:00 UTC, detection de jour manquant, refus d'un prix nul ou negatif, detection de doublon contradictoire. Fonctions exportees, prenant des bougies deja en memoire.
- Critere de validation : `npx vitest run test/fixture/normalise.test.ts` passe, avec un test par cause de refus : horodatage non multiple de 86 400 s, jour manquant dans la serie, prix nul ou negatif, deux lignes du meme jour aux valeurs differentes.
- Piege connu : c'est l'etape qui repond a l'incertitude "fixture non auditee" de la spec. Les bougies daily crypto cloturent a 00:00 UTC ; une source qui cloture en heure locale decale toute la serie et change les resultats du rejeu sans qu'aucun test n'echoue. Ce controle ne vaut que s'il est atteignable depuis un test : la premiere tentative l'avait enfoui dans un script sans export, ou il etait affirme en commentaire et verifiable par personne. Le module vit hors de `src/core/`, donc la regle de purete d'E2 ne le protege pas ; le garder sans IO est une discipline, pas une contrainte outillee.

### E21 - Fixture de bougies et de flux, avec test d'integrite
- Depend de : E24
- Diff estime : **~1950 lignes de donnees + ~50 lignes de test** — hors cible, voir la note de fin
- Fichiers touches : `test/fixtures/candles-btc-usdc.csv`, `test/fixtures/candles-eth-usdc.csv`, `test/fixtures/cash-flows.json`, `test/fixtures/integrity.test.ts`
- Contenu : bougies daily du 2024-01-01 au 2026-08-31 pour BTC et ETH, plus les flux de tresorerie du rejeu.
- Critere de validation : `npx vitest run test/fixtures/integrity.test.ts` passe. Le test verifie le nombre exact de lignes, l'absence de jour manquant, la monotonie des dates, l'absence de prix nul ou negatif, et une empreinte SHA-256 figee par fichier.
- Piege connu : etape dont le diff est illisible sur telephone par nature. La relecture doit porter sur le test d'integrite et sur l'empreinte, pas sur les lignes. Corollaire : toute regeneration ulterieure de la fixture change l'empreinte et doit etre une PR consciente, jamais un effet de bord.

### E22 - Moteur de rejeu
- Depend de : E16, E18, E19, E21
- Diff estime : ~170 lignes
- Fichiers touches : `src/replay/engine.ts`, `test/replay/engine.test.ts`
- Contenu : deroule les 4 configurations de strategie et les 2 benchmarks hold sur la fixture, avec horloge injectee, et retourne un resultat structure.
- Couvre : C29, partiellement (production des metriques par strategie).
- Critere de validation : `npx vitest run test/replay/engine.test.ts` passe et assert que le resultat contient les 6 series attendues, chacune avec valeur finale, TWR, Sharpe 90 j, max drawdown et nombre de declenchements.
- Piege connu : le moteur vit hors de `core/`, donc la regle de purete d'E2 ne le protege pas. C'est precisement la ou une lecture de l'horloge systeme se glisse et rend le rejeu non reproductible. L'horloge doit venir de la fixture, ligne par ligne.

### E23 - Rendu du tableau comparatif et determinisme
- Depend de : E22
- Diff estime : ~110 lignes
- Fichiers touches : `src/replay/report.ts`, `test/replay/report.test.ts`, `package.json`
- Contenu : rendu texte du tableau, script `npm run replay`.
- Couvre : C29 (tableau complet), C30 (deux executions produisent une sortie identique octet pour octet), C31 (le test verifie la production et le determinisme, jamais qu'une strategie en bat une autre).
- Critere de validation : `npm run replay > a.txt && npm run replay > b.txt && cmp a.txt b.txt` sort en 0. `npx vitest run test/replay/report.test.ts` passe.
- Piege connu : C31 est une interdiction, pas une omission. Aucune assertion du type "rebalance > dca" ne doit entrer dans ce fichier de test, meme si le rejeu la rend vraie : ce serait figer en test un resultat que la spec refuse explicitement de valider. Cote determinisme, les pieges sont le formatage de nombres dependant de la locale et tout parcours de `Map` ou `Set` non trie.

### E24 - Telechargement de la fixture et note de source
- Depend de : E20
- Diff estime : ~130 lignes
- Fichiers touches : `scripts/build-fixture.ts`, `docs/fixture-source.md`, `package.json`
- Contenu : le script qui telecharge les bougies, delegue tout controle a `src/fixture/normalise.ts` et ecrit les CSV. La note fige la source, le fuseau de cloture et la politique de trous. `package.json` gagne `tsx` en dependance de developpement.
- Critere de validation : `npx tsx scripts/build-fixture.ts --dry-run` sort en 0, affiche le nombre de jours attendus, et `git status --porcelain` est vide juste apres. `docs/fixture-source.md` existe et nomme explicitement la source, le fuseau et la regle de trou.
- Piege connu : l'ecriture doit etre tout ou rien. La premiere tentative ecrivait le CSV de BTC avant de telecharger ETH : un echec sur ETH laissait une fixture a moitie regeneree sur le disque pendant que le script affichait "aucun fichier ecrit". Telecharger les deux actifs, tout valider, puis ecrire seulement a la fin, via des fichiers temporaires renommes. La regle d'idempotence de `CLAUDE.md` n'est pas negociable et c'est ici qu'elle se joue.
- Piege connu, deuxieme : `tsx` n'etait dans aucune dependance alors que le critere de validation l'invoque. Sans l'ajout a `package.json`, l'etape ne peut pas prouver son propre critere.

---

## Synthese

**24 etapes.** Les 32 criteres d'acceptation de la spec sont couverts, chacun rattache a une etape nommee.

**Parallelisable :**

- Apres E1 : **E2, E3 et E20** sont independants et partent ensemble.
- Apres E3 : **E4, E5 et E6** partent ensemble.
- Apres E4 : **E7, E10, E14, E15 et E17** partent ensemble. C'est le point de fan-out le plus large du plan.
- **E8** part des E6, en parallele de E7.
- Trois chaines longues et independantes se deroulent ensuite en parallele : la couche risque (E7/E8 -> E9), la strategie de reequilibrage (E10 -> E11/E12 -> E13 -> E16), et les benchmarks (E17 -> E18).
- **E20 -> E24 -> E21** ne depend d'aucune des trois et peut avancer du debut a la fin en fond. E24 est ecrite en fin de fichier mais s'ordonnance ici : elle depend de E20 et E21 depend d'elle.
- Le plan se resserre a E22, qui attend E16, E18, E19 et E21.

Chemin critique : E1 -> E3 -> E4 -> E10 -> E12 -> E13 -> E16 -> E22 -> E23, soit **9 etapes**. La chaine de la fixture, E1 -> E20 -> E24 -> E21 -> E22, en compte une de moins et ne devient pas critique.

## Deux points a arbitrer avant de lancer /construire

**1. E21 depasse la regle des 200 lignes et je ne sais pas la redecouper honnetement.** Une fixture de ~970 jours sur deux actifs fait environ 1950 lignes de donnees. La fractionner en dix PR de 200 lignes de CSV ne la rendrait pas plus relisable, juste plus longue a fusionner. J'ai choisi de deplacer la relecture sur le test d'integrite et l'empreinte SHA-256, mais c'est une entorse a la regle, pas une application. A valider ou a trancher autrement.

**2. La v2.0 annoncait la phase 0 en "1 soiree".** Avec 24 PR dimensionnees pour un ecran de telephone, l'estimation ne tient pas. Le plan n'est qu'une hypothese et le nombre d'etapes decoule directement de la contrainte de taille, pas d'un gonflement du perimetre : le perimetre est exactement celui de la spec. Si la duree compte plus que la taille des PR, c'est la regle de taille qu'il faut assouplir, pas la spec qu'il faut couper.
