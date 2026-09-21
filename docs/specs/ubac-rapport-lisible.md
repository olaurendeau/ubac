# Ubac : un rapport quotidien lisible sans glossaire

Cadrage du 2026-09-20. Complète le §9 de `docs/specs/ubac-rebalance.md` et
`docs/rapport-quotidien.md` ; ne modifie ni l'un ni l'autre.
Porte sur le rendu du rapport, `src/report/daily-report.ts`, et sur la lecture
qui l'alimente. Aucun calcul de métrique n'est touché.

## Besoin

L'opérateur lit le rapport quotidien sur son téléphone et ne sait pas ce que
veulent dire P&L, TWR, Sharpe, borne, jambe et la moitié des autres mots du mail.
Le rapport doit donc porter lui-même les définitions de son vocabulaire, dans le
corps du courrier, sans rien à ouvrir ailleurs.
Il doit aussi montrer d'un coup d'œil comment le portefeuille a évolué depuis le
début — une courbe, pas un chiffre.

Mot pour mot : « Ce serait bien d'améliorer le mail, notamment en ajoutant des
définitions du jargon. Je sais pas ce que c'est que les PL T W. R. Sharp, borne,
jambes... Si c'est possible d'inclure un petit graphe de l'évolution globale du
portefeuille (optionnel) ».

## Réponses de l'opérateur

Cinq questions posées le 2026-09-20, cinq réponses.

| # | Question | Réponse retenue |
|---|---|---|
| Q1 | Forme du lexique | **2** — section « Lexique » en fin de rapport, seule. Aucune ligne d'explication sous les titres de section. |
| Q2 | Fréquence et taille | **1** — le vocabulaire entier, dans chaque rapport. |
| Q3 | Contenu du graphe | **1** — performance seule : indice TWR, apports neutralisés. |
| Q4 | Fenêtre du graphe | **3** — tout l'historique, sans plafond. |
| Q5 | Découpage | **3** — lexique et graphe cadrés et livrés dans le même lot. |

La technique de rendu du graphe n'a pas été posée en question : elle est tranchée
en D5 et validée par le coordinateur.

## Périmètre

### Inclus

1. **Une section « Lexique »**, dernière section du corps du rapport, définissant
   en une phrase chaque terme de jargon que le rapport imprime.
2. **Un graphe du TWR cumulé du portefeuille**, rendu en cellules de tableau,
   dans la section « Comparaison », au-dessus du tableau.
3. **La lecture de la série des photos** nécessaire au graphe : une opération de
   plus sur `UbacDatabase`, appelée par `src/jobs/daily.ts`.
4. **La documentation** correspondante dans `docs/rapport-quotidien.md`.

### Exclu explicitement

- **Toute image, tout SVG, toute ressource distante, toute pièce jointe.** Motif
  en H2. La règle du §2 de `docs/rapport-quotidien.md` — « ni feuille de style,
  ni image, ni police distante » — n'est pas assouplie, elle est tenue.
- **Le graphe de la valeur totale en USDC.** Q3=1. Un second graphe serait un
  autre cadrage ; l'argument qui le rendrait recevable est en H3.
- **Les courbes des hold, du ladder et du DCA sur le graphe.** Une seule courbe :
  le portefeuille. Les hold n'ont pas de série stockée — la photo ne porte que
  leurs métriques finales — et les ombres n'ont pas de courbe du tout
  (`docs/rapport-quotidien.md` §6).
- **Le sujet du courrier.** Il contient du jargon (`CASH_BAND`, « jambe(s) »,
  « recul ») et tient sur un écran verrouillé : y glisser une glose le ferait
  déborder. Inchangé.
- **Les alertes ntfy.** Canal court, corps limité, aucun lexique.
- **Une version `text/plain`.** Écart déjà déclaré au §5 de
  `docs/rapport-quotidien.md`, non levé ici.
- **`src/core/`.** Aucune ligne. Aucune métrique n'est calculée, ajoutée ni
  modifiée : le graphe relit l'indice que la photo porte déjà.
- **Toute page web, tout lien sortant, toute pagination.** Le rapport reste un
  courrier autonome.

## Décisions

### D1 — Le lexique est une section unique, à la fin

Q1=2. Une seule section « Lexique », après « Métriques indisponibles », donc en
dernier. Aucune glose dans les tableaux, aucune ligne sous les titres de section.

Conséquence à traiter et non à subir : ce qui est en dernier est ce que Gmail
coupe en premier. Voir H4 et D6.

### D2 — Ce que le lexique couvre

Règle d'appartenance, et non un compte : **le lexique définit tout terme que le
corps du rapport imprime et qui n'est pas du français courant.** Vingt entrées
fixes, présentes chaque jour parce que les titres de section et les en-têtes de
colonne qui les portent sont présents chaque jour :

P&L · TWR · indice de croissance · photo · recul depuis le plus haut ·
max drawdown · Sharpe 90 j · bande · borne · poids, cible et écart · trigger ·
jambe · ombre · hold BTC et hold 50/50 · ladder · DCA · verdict de risque ·
fenêtre OHLCV · prix de clôture · USDC.

Et des entrées **conditionnelles**, rendues seulement quand le rapport du jour
imprime ce qu'elles définissent :

- une entrée par valeur de `Trigger` effectivement imprimée (`NONE`,
  `CASH_BAND`, `RATIO_BAND`) ;
- une entrée par `RejectionCode` effectivement imprimé — les neuf codes glosés
  tous les jours seraient dix-huit lignes de bruit pour des rejets qui
  n'arrivent pas en phase 1 ;
- « suspension », quand l'encadré de suspension est présent ;
- la convention de nommage des clés de la photo (`<strategie>_<metrique>`),
  quand le tableau « Métriques indisponibles » est présent.

Vingt entrées fixes, c'est plus que les « ~15 » de la question Q2 : le compte
n'a jamais été la consigne, la couverture l'est.

**L'exhaustivité des deux vocabulaires fermés est tenue par le typage**, pas par
la relecture : les tables sont des `Record<Trigger, string>` et
`Record<RejectionCode, string>`. Un code ajouté au noyau fait échouer
`make typecheck` chez celui qui l'ajoute. C'est le même motif que
`test/report/contrat-run.test-d.ts`.

### D3 — Où vit le texte des définitions

Dans un module dédié, `src/report/lexique.ts`, pur, importé par
`daily-report.ts`. Pas dans un Markdown lu à l'exécution : ce serait une IO dans
un rendu qui n'en a aucune. Pas dispersé dans `daily-report.ts` : vingt
définitions au milieu du rendu noieraient le rendu, et le plafond du lot
demande un fichier qu'on peut relire seul.

**Le texte est sans accent**, comme tout le corps du rapport. C'est la contrainte
la plus facile à violer de ce lot : on écrit vingt définitions en français d'une
traite, et « pondéré » passe. D'où R6.

### D4 — Le graphe trace le TWR cumulé, et rien d'autre

Q3=1. La série tracée est `portfolio_twr_index - 1`, exprimée en pourcentage
signé — exactement l'unité de la case « P&L cumulé (TWR) » de l'en-tête, dont le
graphe est l'histoire.

La valeur totale en USDC n'est **pas** tracée. Un apport de 10 000 USDC
dessinerait une marche que l'œil lit comme une performance, et c'est le critère
C27. Le graphe est neutralisé des flux parce que la série qu'il lit l'est déjà.

Garde-fou, et non déclaration d'intention : R9 double la valeur totale de chaque
photo sans changer un octet du graphe.

### D5 — Le graphe est fait de cellules de tableau, jamais d'une image

Colonnes verticales : un `<tr>` de `<td>` alignés en bas, chacun portant un bloc
de hauteur fixée en pixels et de couleur de fond. Aucune balise `<img>`, aucun
`<svg>`, aucun `background-image`, aucune URL. Hauteur totale du graphe fixée en
pixels, largeur contenue dans les 520 px du §2.

Les trois autres techniques sont écartées en H2.

### D6 — Tout l'historique, avec une résolution qui décroît

Q4=3 : sans plafond. Lu comme **aucune troncature de la période** — le graphe
montre toujours depuis la première photo — et non comme « une colonne par photo
pour toujours », qui ne tient ni dans 520 px ni sous la coupure de Gmail (H4).

Règle : `MAX_COLONNES` colonnes au plus. Tant que le nombre de photos `N` est
inférieur ou égal à `MAX_COLONNES`, une colonne par photo. Au-delà, les photos
sont groupées par paquets consécutifs de `k = ceil(N / MAX_COLONNES)`, et chaque
colonne porte **la dernière valeur de son paquet**, jamais une moyenne : l'indice
est un niveau, et moyenner des niveaux aplatit la courbe qu'on veut voir. Le
dernier paquet peut être incomplet ; sa dernière valeur reste la photo la plus
récente, ce qui est la propriété qui compte (R11).

`MAX_COLONNES` vaut 90 : 90 colonnes de 4 px plus 1 px d'écart tiennent dans les
~496 px utiles, et une barre de 4 px reste visible sur un écran de téléphone. La
valeur est une constante d'un seul endroit, révisable après le premier vrai
courrier.

Le nombre de colonnes est donc **borné pour toujours**, et avec lui la taille du
HTML. La note sous le graphe dit la résolution : « 1 colonne = k photo(s) ».

**Une agrégation hebdomadaire a été envisagée et écartée** : elle ne borne rien,
elle repousse. 104 colonnes après deux ans, 520 après dix. Le problème
reviendrait identique, et plus tard, c'est-à-dire quand plus personne ne
regarderait.

L'axe est indexé par photo, pas par date : deux colonnes voisines ne couvrent pas
forcément la même durée si un run a sauté. Compromis assumé — un axe calendaire
demanderait des trous et une convention d'interpolation, alors que la note donne
déjà le nombre de photos et les deux dates extrêmes, ce qui suffit à repérer un
historique troué.

### D7 — L'échelle verticale part du minimum de la fenêtre, pas de zéro

Un indice qui varie entre 1,00 et 1,05, tracé depuis zéro, donne quatre-vingt-dix
barres identiques. L'échelle couvre donc le minimum et le maximum de la fenêtre
tracée.

Contrepartie assumée et compensée : une échelle qui n'est pas ancrée à zéro
**exagère visuellement le bruit**, et une variation de 0,3 % peut remplir la
hauteur du graphe. La note sous le graphe donne donc les deux bornes de
l'échelle en pourcentage signé, de sorte que l'amplitude réelle ne soit jamais
ambiguë. Série plate : toutes les colonnes à la même hauteur, la note le dit, et
aucune division par zéro (R13).

### D8 — Les cas limites se disent, ils ne se devinent pas

- **Zéro ou une photo** : aucun graphe, une phrase nommée à la place. Un cadre
  vide se lirait comme un rendu cassé.
- **Photo sans `portfolio_twr_index`, ou valeur non finie** : colonne vide,
  jamais interpolée, jamais mise à zéro. C'est la règle déjà tenue par le reste
  du rapport — « une métrique absente se dit absente, jamais par un zéro ». La
  note compte les colonnes vides.
- **Second run du même jour** : la photo du jour n'est pas réécrite
  (`src/jobs/snapshot.ts`, propriété 4) et le run relit l'indice qu'elle porte.
  Le graphe doit donc être identique au premier, et pas une colonne plus long.
  D'où la règle de composition de D9 et le critère R16.

### D9 — La série vient d'une lecture de plus, faite avant les écritures

Le graphe a besoin de la série des `portfolio_twr_index`, que seule la table
`snapshots` porte. Aujourd'hui le run ne lit que la photo précédente.

- **Une opération de plus sur `UbacDatabase`**, qui rend la série ordonnée de la
  plus ancienne à la plus récente, réduite aux deux colonnes utiles — `run_date`
  et `benchmarks`. Elle **ne remplace pas** `latestSnapshot()`, que la
  réconciliation appelle aussi pour ses positions : dériver l'une de l'autre
  ferait entrer un lot intégré dans le périmètre.
- **Elle est appelée à l'étape 4bis**, là où `latestSnapshot()` l'est déjà,
  et son résultat est porté jusqu'au rendu comme `previousSnapshot` l'est. Motif
  en H5 : une lecture placée juste avant l'envoi du rapport ferait échouer, après
  coup, un run qui a déjà tout écrit.
- **Le point du jour n'est pas relu, il est composé.** La série lue à l'étape
  4bis s'arrête à la veille ; le rendu y ajoute le point du jour, qu'il tient
  déjà de `run.runDate` et `run.benchmarks`. Si le dernier point lu porte la date
  du run — second run du même jour — il est **remplacé**, pas ajouté, ce qui rend
  R16 vrai par construction.
- **Le rendu reste pur.** Il reçoit la série comme il reçoit le reste, dans
  `DailyReportInput`. Aucune IO, aucune horloge, aucun import de `src/jobs/`.

### D10 — Un seul lot, avec une ligne de coupe déclarée d'avance

Q5=3 : lexique et graphe dans le même lot. L'estimation tient sous le plafond de
1 000 lignes ajoutées + supprimées, mais avec une marge mince — voir « Volume
estimé ». Le plan de la phase 1 enregistre que les estimations de ce dépôt se
sont trompées d'un facteur 2 à 3, toujours dans le même sens.

**Ligne de coupe déclarée maintenant, pour ne pas être improvisée sous
pression** : si le lot dépasse, c'est le **graphe et sa lecture de base** qui
partent en second lot, et le lexique qui est livré d'abord. Le lexique est
autonome, il ne dépend d'aucune lecture nouvelle, et c'est lui qui répond au
besoin principal. Le constructeur ne rogne pas le périmètre en silence : il
remonte au coordinateur pour redécoupage.

## Hypothèses challengées

### H1 — « Des définitions du jargon » ne veut pas dire « une glose à côté de chaque terme »

C'est la lecture littérale du besoin, et elle a été soumise à l'opérateur comme
option 3 de Q1. Objection argumentée, avant sa réponse :

Le tableau « Comparaison » a quatre colonnes dans 520 px, et le tableau
« Décision du jour » en a cinq. Un en-tête `Max drawdown (pire recul subi depuis
un sommet)` triple la largeur de sa colonne et fait déborder le tableau
horizontalement sur un téléphone — c'est-à-dire qu'il casse précisément la
lecture qu'on cherchait à réparer. Et une glose répétée à chaque occurrence, tous
les jours, transforme un rapport lu en trente secondes en une page qu'on cesse
d'ouvrir : la définition sert les premiers jours, la donnée sert tous les jours.

L'opérateur a répondu 2 — section unique, en fin. L'objection et la réponse
concordent.

### H2 — « Un graphe dans un mail » ne veut pas dire « une image »

Hypothèse la plus naturelle, et la plus fausse des quatre. Trois techniques
écartées, une retenue.

| Technique | Pourquoi elle est écartée |
|---|---|
| **SVG en ligne** | Gmail supprime `<svg>` du corps. Le graphe disparaîtrait chez le seul lecteur du rapport, sans laisser de trace : ni erreur, ni case vide, rien. |
| **Image distante** | Bloquée par défaut par la plupart des clients mobiles. Elle exigerait en plus d'héberger quelque part une image de la performance du portefeuille, derrière une URL que le client de messagerie appelle en clair : c'est une fuite de donnée patrimoniale pour un ornement. |
| **Pièce jointe CID** | Le corps de l'API Brevo `/v3/smtp/email` n'a pas de champ d'identifiant de contenu. La pièce jointe arriverait donc **attachée**, pas intégrée : l'opérateur devrait ouvrir un fichier, ce qui est exactement ce que la lecture sur téléphone ne fait pas. S'y ajoute un rasterisateur à faire entrer dans le dépôt, pour un rendu qui cesserait d'être une chaîne comparable ligne à ligne. |
| **Cellules de tableau** *(retenue)* | Rien à charger, rien à autoriser, aucune dépendance, et le rendu reste une chaîne que le test compare caractère par caractère. Le §2 est tenu tel quel plutôt qu'assoupli. |

### H3 — « Évolution globale du portefeuille » ne désigne pas une seule courbe

Le besoin ne tranche pas, et les deux lectures disent des choses opposées.
L'indice TWR répond « est-ce que ça marche », la valeur totale en USDC répond
« combien j'ai ». Une courbe de valeur totale n'est pas illégitime — elle serait
même la plus parlante — mais elle contient les apports, et une marche verticale
le lendemain d'un virement se lit comme une performance. C'est le critère C27,
et c'est la raison pour laquelle le P&L du rapport est déjà un TWR et jamais une
variation de valeur.

Question posée, réponse 1 : performance seule. La courbe de valeur totale reste
possible plus tard **à condition d'être nommée pour ce qu'elle mesure** et
tracée à côté de l'autre, jamais à sa place.

### H4 — Une section en fin de rapport n'est pas forcément lue

Gmail coupe les messages au-delà d'environ 102 ko et affiche « Afficher le
message entier ». Le lexique est en dernier (D1) : c'est lui que la coupure
emporte. Et le graphe, s'il n'était pas borné (D6), est précisément ce qui ferait
grossir le rapport jusqu'à ce seuil — quatre-vingt-dix colonnes coûtent quelques
kilo-octets, cinq mille en coûteraient plusieurs centaines.

Les deux réponses de l'opérateur, Q1=2 et Q4=3, se contredisent donc si on les
applique naïvement. D6 les réconcilie en bornant le nombre de colonnes, et R17
mesure le résultat sur une série de 5 000 photos plutôt que de faire confiance au
raisonnement.

### H5 — Ajouter une lecture pour le rapport ne doit pas ajouter un mode de panne au run

Objection contre notre propre première idée. Lire la série juste avant
`deliverReport` aurait été le plus simple : c'est là qu'on s'en sert. Mais le
rapport part **après** que tout est écrit, et cet ordre est délibéré
(`docs/rapport-quotidien.md` §2 ter). Une lecture de base à cet endroit peut
lever, et une exception après les écritures transforme un run réussi en
`JOB_FAILED` — pour un graphe.

D'où D9 : la lecture est faite à l'étape 4bis, au milieu du run, là où une panne
de base doit de toute façon arrêter le run et où elle ne ment sur rien.

### H6 — Le graphe n'est pas facultatif à l'exécution parce qu'il est facultatif au cadrage

L'opérateur l'a déclaré optionnel, ce qui porte sur l'opportunité de le faire, et
il a répondu Q5=3. Une fois livré, un graphe qui échoue en silence est pire que
pas de graphe : R14 et R15 exigent une phrase nommée plutôt qu'un cadre vide, et
R10 à R17 le tiennent sur les fenêtres où il pourrait se dégrader sans bruit.

## Critères d'acceptation

Vérifiables, et numérotés R1 à R22. La phase 1 n'ayant pas de critères numérotés
(`docs/plans/ubac-phase-1.md`, « Avertissement sur la référence »), ce préfixe
est propre à ce cadrage et n'entre en collision avec aucun C de la phase 0.

### Le lexique

- **R1** — Le rapport rendu porte une section « Lexique », et elle est la
  dernière du corps : aucune section ne la suit, y compris quand
  « Métriques indisponibles » est présente.
- **R2** — Chaque entrée porte un terme et une définition d'une phrase. Aucune
  entrée vide, aucun terme sans définition.
- **R3** — Sur l'état de référence, chaque terme du lexique apparaît au moins une
  fois dans le corps **hors** de la section « Lexique ». Une entrée morte —
  définir un mot que le rapport n'imprime pas — fait échouer le test.
- **R4** — Les gloses de `Trigger` et de `RejectionCode` sont portées par des
  tables exhaustives fermées par le typage. Ajouter une valeur à l'un de ces
  deux types du noyau, sans ajouter sa glose, fait échouer `make typecheck`.
- **R5** — Les entrées conditionnelles suivent ce que le rapport imprime : un run
  sans rejet ne rend aucune entrée de rejet ; un run dont un verdict vaut
  `REJECTED:MIN_CASH` rend l'entrée `MIN_CASH`, et elle seule.
- **R6** — Le corps rendu sur l'état de référence, lexique compris, ne contient
  **aucun caractère accentué**. La sonde couvre tout le HTML, pas seulement la
  nouvelle section.

### Le graphe

- **R7** — Le graphe est rendu dans la section « Comparaison », entre le titre et
  le tableau.
- **R8** — Le HTML rendu ne contient ni `<img`, ni `<svg`, ni `background-image`,
  ni `url(`, ni aucune URL absolue. Sonde sur le rapport entier.
- **R9** — Le graphe trace l'indice TWR et jamais la valeur : doubler
  `totalValue` et la valeur totale de chaque photo de la série ne change **pas un
  octet** du graphe rendu.
- **R10** — Le nombre de colonnes rendues ne dépasse jamais `MAX_COLONNES`,
  vérifié pour un nombre de photos valant 1, 2, 89, 90, 91, 1 000 et 5 000.
- **R11** — La dernière colonne porte toujours la valeur de la photo la plus
  récente, quel que soit le nombre de photos et que le dernier paquet soit
  complet ou non.
- **R12** — La note sous le graphe donne le nombre de photos, la première et la
  dernière date, et la résolution. La résolution vaut « 1 colonne = 1 photo »
  tant que le nombre de photos est inférieur ou égal à `MAX_COLONNES`.
- **R13** — La note donne le minimum et le maximum de l'échelle en pourcentage
  signé. Une série strictement plate rend des colonnes de hauteur égale, le dit,
  et ne divise pas par zéro.
- **R14** — Zéro ou une photo : aucun graphe, une phrase nommée à la place.
  Jamais de cadre vide, jamais de colonne unique pleine hauteur.
- **R15** — Une photo dont `portfolio_twr_index` est absent ou non fini laisse sa
  colonne vide : aucune interpolation, aucun zéro. La note compte les colonnes
  vides.
- **R16** — Un second run du même jour rend exactement le même graphe que le
  premier : même nombre de colonnes, mêmes hauteurs, même note.
- **R17** — Sur une série de 5 000 photos, le HTML entier du rapport reste sous
  100 000 caractères, marge prise sous la coupure de Gmail.

### La plomberie

- **R18** — `UbacDatabase` expose la lecture de la série des photos, ordonnée de
  la plus ancienne à la plus récente. Elle ne remplace pas `latestSnapshot()`,
  dont les appelants sont inchangés. Couverte par `test/adapters/db.test.ts`,
  donc par `make test-db` ; un double la porte pour `test/jobs/daily.test.ts`.
- **R19** — L'appel a lieu à l'étape 4bis du run, avec `latestSnapshot()`, et non
  après les écritures : le chemin allant de la fin des écritures à l'envoi du
  rapport ne gagne aucun nouvel appel susceptible de lever.
- **R20** — `src/report/` n'importe toujours pas `src/jobs/` :
  `test/structure.test.ts` et les fixtures de lint restent verts et inchangés.
- **R21** — Le rendu reste pur : `test/report/daily-report.test.ts` ne monte ni
  base, ni réseau, ni horloge, et rend le rapport entier sur un état figé.
- **R22** — `make typecheck` et `make test` passent.
  `test/report/contrat-run.test-d.ts` est mis à jour pour la nouvelle entrée et
  refuse toujours un run abandonné.

## Volume estimé

Compté ajouts + suppressions, hors fixtures générées et lockfiles — il n'y en a
aucun ici.

| Fichier | Estimation |
|---|---|
| `src/report/lexique.ts` | ~130 |
| `src/report/daily-report.ts` | ~230 (lexique, graphe, entrée, notes) |
| `src/adapters/db.ts` | ~45 |
| `src/jobs/daily.ts` | ~30 |
| `test/report/daily-report.test.ts` | ~200 |
| `test/report/lexique.test.ts` | ~90 |
| `test/jobs/daily.test.ts` et `test/jobs/doubles.ts` | ~40 |
| `test/adapters/db.test.ts` | ~40 |
| `test/report/contrat-run.test-d.ts` | ~15 |
| `docs/rapport-quotidien.md` | ~90 |
| **Total** | **~910** |

Sous le plafond de 1 000, avec moins de 10 % de marge. C'est la raison d'être de
la ligne de coupe de D10.

Note de méthode : la sonde de R17 rend un rapport sur 5 000 photos. Si elle
s'avère lente une fois instrumentée par v8, elle reçoit un délai cible sur son
bloc `describe`, jamais un relèvement du délai global
(`docs/marge-des-delais.md`).

## Incertitudes

1. **La place du graphe.** Il est mis dans « Comparaison » (R7) parce qu'il
   est l'histoire de la ligne « Portefeuille » de ce tableau, et parce que le §9
   a placé la distance au prochain déclenchement en deuxième position
   délibérément — « l'information la plus utile du rapport ». Le mettre juste
   sous l'en-tête, en premier coup d'œil, est défendable et repousse la distance
   d'environ 70 px. Un vrai courrier sur le téléphone de l'opérateur tranchera
   mieux que ce cadrage ; le changement coûte une ligne.
2. **`MAX_COLONNES` = 90 et la largeur de barre.** Calculé sur les 520 px du §2,
   pas mesuré sur un appareil. Constante d'un seul endroit.
3. **Le lexique ne peut pas être prouvé complet dans les deux sens.** R3 attrape
   les entrées mortes, R4 ferme les deux vocabulaires du noyau. Mais les `reason`
   du noyau sont du texte libre, cités tels quels, et peuvent contenir un mot que
   le lexique ne couvre pas. Aucun test ne peut le dire : c'est un point de
   relecture, et il restera ouvert.
4. **L'absence de champ d'identifiant de contenu dans l'API Brevo** (H2) vient de
   la documentation de l'API, pas d'un essai en réel dans ce lot. S'il existait,
   la décision ne changerait pas — une pièce jointe reste un fichier à ouvrir —
   mais l'argument serait à réécrire.
5. **Le seuil de coupure de Gmail**, ~102 ko, est un comportement observé et
   documenté, pas un contrat. R17 prend de la marge plutôt que de viser le seuil.
6. **La croissance de la lecture d'historique.** Sans plafond, la requête relit
   toutes les photos chaque jour : 365 lignes après un an, 3 650 après dix. Deux
   colonnes par ligne, c'est négligeable pour un job quotidien, et aucun plafond
   n'est posé — mais le jour où il en faudrait un, ce sera une décision, pas un
   ajustement technique.
7. **L'axe est indexé par photo, pas par date** (D6). Si les runs sautent
   souvent, l'axe se déforme. La note donne de quoi le repérer, pas de quoi le
   corriger.
