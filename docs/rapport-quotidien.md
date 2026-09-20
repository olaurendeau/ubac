# Rapport quotidien

Le rapport email de la spec §9, en trois fichiers et trois responsabilités :

| Fichier | Ce qu'il fait |
|---|---|
| `src/report/daily-report.ts` | **rend** le courrier — sujet, HTML, tags |
| `src/adapters/mailer.ts` | **l'envoie**, par l'API HTTP Brevo `/v3/smtp/email` |
| `src/jobs/daily.ts` | **décide qu'il part**, une fois le run conclu et les alertes poussées |

Rendre et envoyer sont séparés pour une raison précise : le rendu est pur, donc
il se compare à une sortie attendue sans réseau, sans clé et sans run.
`test/report/daily-report.test.ts` rend le rapport entier sur un état figé et le
compare ligne à ligne ; `test/adapters/mailer.test.ts` relit le corps
réellement publié contre un transport double ; `test/jobs/daily.test.ts` tient
le branchement.

Le run quotidien est décrit dans [run-quotidien.md](run-quotidien.md) ; les
métriques que le rapport consomme viennent de `src/jobs/snapshot.ts`. Le canal
court — les alertes push — est dans [alertes.md](alertes.md).

## 1. Condition de réception : SPF et DKIM

**Le domaine d'envoi doit être authentifié SPF et DKIM, sinon les rapports
finissent en spam** (§9). Ce n'est pas une affaire de code : ce sont deux
enregistrements DNS à poser, et c'est l'opérateur qui s'en charge dans la
console Brevo. C'est fait, et vérifié en réel — Brevo a rendu 201 et l'événement
`delivered` est confirmé.

**Le domaine n'est pas dans le dépôt, et le nom que la spec avance n'est pas
celui en service.** Le §9 écrit `olalpinesolutions` ; l'adresse réellement
utilisée arrive par `BREVO_SENDER`. Aligner la spec est une décision de
l'opérateur, pas un ajustement technique : l'écart est signalé ici, il n'est pas
tranché ici. Figer le domaine en constante du dépôt aurait de toute façon été le
mauvais choix — il appartient à l'opérateur, pas au code.

Aucun test de ce dépôt n'en dépend, et c'est délibéré : le rendu ne parle à
personne, et l'envoi est testé contre un double de transport. Un rapport qui
part sans SPF ni DKIM part quand même — il arrive simplement en indésirable, ce
qu'aucune assertion locale ne peut constater. Ce que les tests **peuvent** dire
s'arrête au 201 ; la réception est affaire de DNS.

## 2. Ce que le rapport contient

Les six points du §9, dans l'ordre où ils apparaissent :

| Section | Contenu | Source |
|---|---|---|
| En-tête | valeur totale, P&L jour et cumulé en TWR | `totalValue`, `portfolio_twr_index` |
| Distance au prochain déclenchement | poids USDC contre sa bande, ratio BTC/ETH contre la sienne quand B est armé | calculée par le rendu |
| Décision du jour | les quatre stratégies, `trigger NONE` compris, avec le verdict de risque | `outcomes` |
| Allocation | poids constatés contre cibles, et l'écart | `weights`, `params.targets` |
| Comparaison | TWR, max drawdown et Sharpe 90 j, portefeuille contre hold BTC et hold 50/50 ; ladder et DCA y figurent **sans courbe**, avec leur raison (section 6) | `snapshots.benchmarks` |
| Métriques indisponibles | ce que le noyau n'a pas pu rendre, et pourquoi | `benchmarkGaps` |
| **Lexique** | une définition d'une phrase par terme de jargon que le corps imprime (section 9) | `src/report/lexique.ts` |

HTML en ligne, une colonne, largeur maximale de 520 px : ni feuille de style, ni
image, ni police distante. Un client mobile qui bloque les ressources externes —
c'est le défaut de la plupart — rend le même rapport. Le corps est **sans
accent**, comme les `reason` du noyau qu'il cite telles quelles.

Tag `daily-report` sur chaque envoi (§9), figé dans `REPORT_TAG` et **imposé**
par l'envoi : `mailer.ts` importe la constante — deux littéraux divergeraient —
et l'ajoute en tête de ce qu'il reçoit plutôt que de le retransmettre. Le §9 dit
« sur chaque envoi », et le seul endroit qui sache ce qu'est un envoi est
celui-là ; un rendu qui oublierait le tag part quand même tagué.

### Un rapport part même quand rien ne se passe

`renderDailyReport` rend un courrier pour tout run achevé. Aucune branche ne rend
`undefined`, et l'objet du message dit ce qui s'est passé :

```
Ubac 2026-09-13 — 100000.00 USDC — aucun declenchement
Ubac 2026-09-13 — 100000.00 USDC — CASH_BAND, 2 jambe(s)
Ubac 2026-09-13 — 100000.00 USDC — SUSPENDU (recul -26.12 %)
```

Un run sans action doit laisser une trace : sans elle, l'opérateur ne distingue
pas un système qui n'a rien eu à faire d'un système qui n'a pas tourné. La
surveillance de l'absence, elle, ne passe pas par le mail — c'est le healthcheck
du §9, et il appartient au lot Q6.

**Ce n'est pas seulement une propriété du rendu, c'est une propriété de l'envoi.**
`deliverReport` n'a aucune condition sur le trigger : tout run conclu poste son
courrier. La sonde du branchement le vérifie sur un run dont les quatre
stratégies rendent `NONE`.

## 2 bis. Un run abandonné n'envoie pas de rapport

Tranché, et pas laissé au hasard : `deliverReport` prend une **branche nommée**
qui journalise son motif et rend `SKIPPED`.

| Fin du run | Rapport | Ce qui prévient l'opérateur |
|---|---|---|
| `COMPLETED` | envoyé, `trigger NONE` compris | le rapport lui-même |
| `ABORTED` (réconciliation) | `SKIPPED` | alerte `RECONCILIATION_DRIFT`, priorité `URGENT` |
| `ABORTED` (valorisation, stratégie indécidable) | `SKIPPED` | alerte `RUN_ABORTED`, priorité `URGENT` |
| exception | aucun | alerte `JOB_FAILED`, puis l'erreur remonte |

Deux raisons, et la première suffirait.

1. **L'abandon est déjà dit, et mieux dit.** Un push part dans la minute, avec
   l'étape, le code et le motif. Un courrier qui répéterait la même nouvelle au
   petit déjeuner arriverait après la bataille. Le silence que le §9 craignait —
   un abandon indistinguable d'un job qui n'a pas tourné — est fermé par
   l'alerte : [alertes.md](alertes.md) §2 bis, et `RUN_ABORTED` existe pour ça.
2. **Un rapport d'abandon serait un rapport à trous.** Distance au
   déclenchement, allocation, comparaison, P&L : rien de tout cela n'existe
   quand le run s'arrête à la réconciliation. `CompletedRun` les exige tous, et
   `test/report/contrat-run.test-d.ts` refuse un run abandonné **par le typage**.
   Un courrier dont cinq sections sur six diraient « indisponible » apprendrait
   à ne plus ouvrir le courrier.

Ce qui lèverait la décision : un rendu d'abandon qui **ne serait pas** le rapport
quotidien amputé — une page qui dit l'étape, l'état lu et ce qu'il aurait fallu
pour continuer. C'est un autre objet, et un autre lot.

## 2 ter. Un échec d'envoi ne fait pas échouer le run

Le rapport part **après** que tout est écrit — décisions, photo, alertes. Un
refus de Brevo, une panne réseau ou un délai dépassé ne défont donc rien : le
statut reste `COMPLETED`, les quatre lignes de `decisions` et la photo du jour
sont là.

Mais l'envoi n'est pas silencieux pour autant, sur trois canaux :

- une **ligne de journal** dédiée, `rapport quotidien : NON PARTI — <motif>` ;
- le **code de sortie**. `reported()` exige un run conclu, ses alertes parties
  **et** son rapport parti ; le point d'entrée sort en 1 sinon, et le
  déclencheur extérieur le voit rouge.
- le **ping du healthcheck**, qui part sans son marqueur : updown.io lit `DOWN`,
  et le corps du pulse dit `rapport_non_parti=oui`.
  [healthcheck.md](healthcheck.md) §4.

Les deux derniers sortent du **même prédicat**, `toutParti` dans `daily.ts`, et
c'est délibéré : le code de sortie se lit sur la machine, le marqueur se lit chez
updown.io, et un opérateur qui verrait `UP` d'un côté et rouge de l'autre ne
saurait pas lequel croire. C'est aussi ce qui impose l'ordre du run — **alertes,
rapport, ping** : la seule façon de dire qu'un rapport n'est pas parti est
d'avoir essayé de l'envoyer d'abord.

Ce qui n'est **pas** fait : pousser une alerte. Le catalogue des sept événements
n'a pas d'entrée pour « rapport non envoyé », et en détourner une — `JOB_FAILED`
pousserait « une exception a échappé au run » — dirait quelque chose de faux sur
le canal le plus urgent, celui qui traverse le mode « ne pas déranger ». Le code
de sortie et le pulse, eux, ne mentent pas.

La garantie « ne rejette jamais » vit dans `src/adapters/mailer.ts`, en un seul
endroit, comme celle de `notifier.ts` : le run n'entoure l'envoi d'aucun `try`.

## 3. La distance au prochain déclenchement

C'est « l'information la plus utile du rapport : elle dit quand quelque chose va
se passer » (§9). C'est aussi **la seule valeur que le noyau ne produit pas** :
`decide()` dit si la bande est franchie, jamais de combien il s'en faut. Donc la
seule qui puisse être fausse sans qu'aucun test du noyau ne bronche, d'où
`bandDistance` exportée et sondée aux bornes, des deux côtés.

Elle s'exprime **sur l'axe de la bande**, pas en variation de prix : une marge de
poids en points de pourcentage, une marge de ratio en unités de ratio. Convertir
en « de combien la crypto doit bouger » est une seconde métrique, utile mais non
livrée : elle est indéfinie dès que la ligne crypto est vide, et une promesse
plus modeste et entièrement vraie vaut mieux qu'une promesse partiellement
vérifiée.

Trois cas, tranchés ici parce que le §9 ne les tranche pas :

| Position | Statut rendu | Ce que le rapport affiche |
|---|---|---|
| Dans la bande | `INSIDE` | la plus courte des deux marges, et la borne qu'elle désigne |
| **Exactement sur une borne** | `INSIDE`, `onEdge` | « sur la borne — la bande est fermee, le moindre pas au-dela declenche » |
| **Déjà hors bande** | `CROSSED` | « franchie — X au-dela de la borne » : le dépassement, pas une distance |

**Sur une borne, rien n'est encore déclenché.** Les bornes sont dans la bande
(C6) : `decide()` tire strictement sous la borne basse et strictement au-dessus
de la haute, jamais dessus. Rendre `CROSSED` avancerait le déclenchement d'un
jour ; afficher « 0.00 pt » sans le drapeau laisserait croire à un arrondi.

**Déjà hors bande, il n'y a plus de distance à parcourir.** Afficher zéro
confondrait « au bord » et « dehors », qui appellent des lectures opposées :
l'un annonce, l'autre constate. La valeur utile devient alors le dépassement.

À égalité parfaite des deux marges, c'est la borne **basse** qui est désignée.
Choix arbitraire mais déterministe : un rapport se rejoue à l'identique.

Le garde-fou qui tient tout cela n'est pas une relecture : `bandDistance` écrit
les mêmes comparaisons que `locate()` — `lt` et `gt`, jamais `lte` ni `gte` — et
un test confronte son verdict à celui de `decide()` sur le même état, aux deux
bornes et de part et d'autre. Une inversion ferait diverger les deux.

## 4. Le P&L est un TWR, jamais une variation de valeur

Un apport de 10 000 USDC se lirait sinon comme une performance : c'est l'objet du
critère C27 de la phase 0.

- **Cumulé** : l'indice de croissance moins 1. L'indice vaut 1 à la première
  photo et ne bouge que des rendements, flux exclus — `indice - 1` *est* le TWR
  depuis l'origine, au même titre que `timeWeightedReturn` rend son produit moins
  1. Changement d'unité, pas second calcul.
- **Du jour** : le quotient de deux indices consécutifs, moins 1. Les deux sont
  chaînés flux exclus, donc leur quotient l'est aussi.

Le P&L du jour demande donc la photo de la veille. Elle est **strictement
antérieure** ou il n'est pas rendu : un second run du même jour relit la photo du
jour, le quotient vaudrait exactement 1, et le rapport annoncerait une journée
plate qui n'a pas eu lieu. Sans photo de référence, la case dit « indisponible »
et la note dit pourquoi — elle ne se replie jamais sur la valeur brute.

## 5. Ce que le rapport ne peut pas dire, et pourquoi

Une métrique absente se dit absente, **avec son motif**, jamais par un zéro : un
Sharpe à 0 se lirait « performance neutre constatée », un drawdown à 0 se lirait
« tout va bien ». Les motifs viennent de `benchmarkGaps`, pas d'une phrase
inventée par le rendu.

Quatre absences sont structurelles en phase 1 :

- **Max drawdown et Sharpe du portefeuille.** La photo porte l'indice et son
  sommet, pas la série ; ni le pire recul passé ni un écart-type ne s'en lisent.
  Ce qui est rendu, et nommé comme tel, est le **recul actuel depuis le plus
  haut** — celui que la règle de suspension du §6 applique. Ce n'est pas un max
  drawdown, et l'appeler ainsi serait faux.
- **Courbes ladder et DCA.** `snapshot.ts` ne les écrit pas. C'est un écart
  assumé avec le §9 de la spec, traité à part en section 6 : le rapport le dit
  dans le tableau de comparaison, pas seulement ici.
- **Les deux fenêtres ne coïncident pas.** Les hold sont dérivés de la fenêtre
  OHLCV du run ; l'indice du portefeuille est chaîné depuis la première photo.
  Tant que le système n'a pas tourné aussi longtemps que la fenêtre, les colonnes
  mesurent des périodes différentes. Le rapport le dit sous le tableau plutôt que
  d'aligner deux chiffres qui ne se comparent pas.
- **Aucune version texte.** Le courrier est HTML seul. Une alternative `text/plain`
  aiderait la délivrabilité ; elle n'est pas livrée.

## 6. Écart assumé avec le §9 : ni courbe ladder, ni courbe DCA

### La divergence

| Source | Ce qui est dit, ce qui est fait |
|---|---|
| `docs/specs/ubac-rebalance.md` §9 | « Comparaison au hold BTC, au hold 50/50, au **ladder shadow** et au **DCA shadow**. » |
| `docs/specs/ubac-rebalance.md` §4, `snapshots.benchmarks` | `{hold_btc, hold_5050, ladder, dca}` |
| `src/jobs/snapshot.ts` | écrit `hold_btc` et `hold_5050` ; les clés `ladder` et `dca` sont **absentes**, pas nulles |
| `src/report/daily-report.ts` | rend les quatre lignes ; les deux ombres portent leur raison à la place des chiffres |

### Pourquoi les deux courbes ne sont pas écrites

**En phase 1, aucune stratégie ne place d'ordre.** Les trois portefeuilles
simulés seraient donc le portefeuille réel, au centime près, et trois courbes
identiques feraient lire une comparaison là où il n'y en a aucune. Le §9 attend
quatre comparaisons parce qu'il décrit un système qui exécute ; tant qu'il
observe, deux d'entre elles n'ont rien à comparer.

Rendre ces colonnes serait **pire que de ne pas les rendre** : une comparaison
fausse, affichée comme une information de confiance sur un téléphone. Un
opérateur qui lit « ladder +25,00 % » à côté de « portefeuille +25,00 % » en
conclut que sa stratégie fait jeu égal avec son benchmark, alors qu'il regarde
deux fois le même chiffre.

### Pourquoi le rapport le dit quand même, et dans le tableau

Une absence sans motif, à l'endroit où l'opérateur cherche l'information, se lit
comme une panne. Les deux lignes figurent donc **dans le tableau de
comparaison** — `Ladder (ombre)` et `DCA (ombre)` —, et la raison occupe les
trois colonnes de métriques :

```
Ladder (ombre) | sans courbe en phase 1 : aucune strategie n'execute,
                 son portefeuille simule serait le portefeuille reel
```

Ni chiffre, ni « indisponible » : « indisponible » annoncerait un trou de la
photo, réparable, alors que c'est une absence assumée. Leur **décision du jour**
figure bien au rapport, une section plus haut — ce qui est observable l'est.

Deux sondes tiennent cette affirmation dans `test/report/daily-report.test.ts` :
l'une constate que la mention est bien dans le tableau, entre les hold et les
notes ; l'autre qu'aucune courbe n'est fabriquée — les lignes d'ombre ne portent
aucun nombre, et planter une clé `ladder_twr` dans la photo ne change pas un
octet du rendu.

### Ce qui lèverait l'écart

Une **simulation des ombres au jour le jour** : faire tourner ladder et DCA sur
un portefeuille simulé propre à chacun, chaîné de photo en photo. C'est ce que
le rejeu historique fait déjà sur une période passée — `src/replay/engine.ts`,
résultats dans [resultats-phase-0.md](resultats-phase-0.md) ; l'amener dans le
run quotidien n'appartient pas à la phase 1. Le jour où ces courbes existeront, les
deux lignes devront prendre leurs chiffres, et la seconde sonde est ce qui le
rappellera.

`docs/specs/ubac-rebalance.md` n'est **pas** modifiée. Aligner la spec sur ce
choix est une décision de l'opérateur, pas un ajustement technique de ce lot :
la divergence est signalée ici, elle n'est pas tranchée ici.

## 7. Le rendu ne connaît pas le run

`eslint.config.js` interdit à `src/report/` d'importer `src/jobs/`, et la règle a
raison : un rendu qui importerait le run ne se testerait plus sans monter un run.
`CompletedRun` est donc une forme déclarée dans le rendu, que `DailyRunResult`
satisfait.

« Structurellement compatible » est exactement le genre de promesse qui devient
fausse en silence, alors elle est fermée par le typage et non par la convention :
`test/report/contrat-run.test-d.ts` assigne le résultat du run à la forme du
rendu, champ par champ et branche par branche, et refuse un run abandonné. Une
divergence fait échouer `make typecheck` chez celui qui l'a introduite.

Même motif pour les clés de `snapshots.benchmarks`, recopiées faute de pouvoir
être importées : un rapport qui lirait `holdbtc_twr` pendant que la photo écrit
`hold_btc_twr` n'afficherait pas une erreur, il afficherait « indisponible ». Un
test confronte les deux tables.

## 8. L'envoi : l'API HTTP, et le transport qu'on ne réécrit pas

`src/adapters/mailer.ts` fait un POST sur `https://api.brevo.com/v3/smtp/email`
et rien d'autre. Le corps porte cinq champs, et c'est **exactement la forme qui a
été éprouvée en réel** contre le compte de l'opérateur avant d'être écrite :

```json
{
  "sender": { "email": "<BREVO_SENDER>" },
  "to": [{ "email": "<BREVO_RECIPIENT>" }],
  "subject": "…",
  "htmlContent": "…",
  "tags": ["daily-report"]
}
```

Quatre choix, et leur motif.

**SMTP est écarté.** Le job tourne en serverless (§10) : une session SMTP ouvre
une connexion longue, négocie STARTTLS et attend des réponses ligne à ligne, sur
un port que la plupart des plateformes ferment en sortie. Aucune bibliothèque
SMTP n'entre dans ce dépôt.

**Le transport est `src/adapters/http.ts`, pas un second client.** Le bornage des
erreurs, le délai de 5 s et la garantie « ne rejette jamais » y vivent déjà,
relus — voir [alertes.md](alertes.md) §4. En écrire un second aurait doublé la
surface où une clé peut fuir, et c'est celui qui n'a pas été relu qui fuit. La
contrepartie est déclarée : `HttpOutcome` ne rend pas le corps de la réponse,
donc le `messageId` du 201 n'est pas lisible. Le statut suffit à dire « parti »
ou « pas parti » ; retracer un courrier précis se fait dans la console Brevo,
avec le tag.

**Un destinataire, dans une liste d'un élément.** Plusieurs destinataires seront
une décision, pas une conséquence de ponctuation — et une liste les rendrait
visibles les uns des autres sans qu'aucune ligne de code ne le dise.

**La clé ne sort que par l'en-tête `api-key`.** `mailer.ts` ne fabrique
**aucune** chaîne d'échec : le motif vient de `motifDe`, vocabulaire fermé de
quatre variantes, et le filet du `catch` rend une constante sans jamais lire ce
qui a été jeté. Les sondes de fuite de `test/adapters/mailer.test.ts` font
circuler une clé factice dans tout ce qu'un transport peut lever ou rendre, et
la cherchent partout — message, nom, cause, pile, propriétés non énumérables.

### Les trois variables

| Variable | Rôle | Forme exigée |
|---|---|---|
| `BREVO_API_KEY` | authentifie le POST | non vide |
| `BREVO_SENDER` | expéditeur, sur le domaine SPF/DKIM | une adresse |
| `BREVO_RECIPIENT` | destinataire | une adresse, une seule |

Les deux dernières sont un **écart assumé avec le §10**, qui ne fige que la clé :
une clé d'API ne dit ni de qui part le courrier ni à qui il va. Même traitement
que `NTFY_URL` et `NTFY_TOPIC` ([alertes.md](alertes.md)), et même conséquence —
`.env.example` les porte sans valeur, et `loadConfig()` refuse de démarrer sans
elles.

Le contrôle de forme n'est pas cosmétique : Brevo refuse **l'envoi entier** sur
une adresse mal formée. Une virgule à la place d'un point ne donne pas un
rapport mal adressé, elle donne un rapport perdu, et la différence ne se lit que
dans un code HTTP. Le message d'erreur nomme la variable et **ne cite jamais sa
valeur** : une adresse est une donnée personnelle, et un message d'erreur finit
dans un journal.

## 9. Le lexique : le rapport porte ses propres définitions

L'opérateur lit le rapport sur son téléphone et ne sait pas ce que veulent dire
P&L, TWR, Sharpe, borne ou jambe. Le rapport porte donc les définitions de son
vocabulaire **dans le corps du courrier**, sans rien à ouvrir ailleurs.

### Une section unique, en dernier

Une seule section « Lexique », après « Métriques indisponibles », donc en
dernier. Aucune glose dans les tableaux, aucune ligne sous les titres de section.

La lecture littérale — une glose à côté de chaque terme — a été écartée, et pour
une raison mesurable : le tableau « Comparaison » a quatre colonnes dans 520 px,
« Décision du jour » en a cinq. Un en-tête `Max drawdown (pire recul subi depuis
un sommet)` triple la largeur de sa colonne et fait déborder le tableau
horizontalement sur un téléphone — il casse précisément la lecture qu'on
cherchait à réparer. Et une glose répétée à chaque occurrence, tous les jours,
transforme un rapport lu en trente secondes en une page qu'on cesse d'ouvrir :
la définition sert les premiers jours, la donnée sert tous les jours.

Conséquence traitée et non subie : **ce qui est en dernier est ce que Gmail coupe
en premier**, au-delà d'environ 102 ko. Le rapport en est loin — une vingtaine de
kilo-octets —, et tout ce qui le ferait grossir devra en tenir compte : c'est une
contrainte pour les lots à venir, pas une réserve de place.

### Ce que le lexique couvre, et comment on le sait

La règle est une règle d'appartenance, pas un compte : **le lexique définit tout
terme que le corps du rapport imprime et qui n'est pas du français courant.**

Vingt entrées fixes, présentes chaque jour parce que les titres de section et les
en-têtes de colonne qui les portent le sont. Et des entrées **conditionnelles**,
rendues seulement quand le rapport du jour imprime ce qu'elles définissent : une
par valeur de `Trigger` réellement imprimée, une par `RejectionCode` réellement
imprimé, « suspension » quand l'encadré est présent, et la convention de nommage
des clés de la photo quand le tableau des trous l'est. Gloser les neuf codes de
refus tous les jours serait neuf lignes de bruit pour des rejets qui n'arrivent
pas en phase 1.

**Le terme d'une entrée est ce que le corps imprime**, et non le nom savant de la
chose : un opérateur qui bute sur la colonne « Risque » cherche « risque », pas
« verdict de la couche de risque ». Ce n'est pas seulement de l'ergonomie, c'est
ce qui rend la règle vérifiable — une sonde relit le corps rendu et **refuse une
entrée morte**, c'est-à-dire un mot défini que le rapport n'imprime nulle part.

Deux entrées de la liste de cadrage sont donc nommées par ce que le rapport
affiche plutôt que par leur libellé de spec : « poids » définit aussi les
colonnes Cible et Écart, et « hold » couvre Hold BTC et Hold 50/50. Le compte de
vingt est inchangé ; ce qui change est le mot sous lequel on les cherche.

### L'exhaustivité est tenue par le typage, pas par la relecture

Les deux vocabulaires fermés du noyau sont portés par des `Record<Trigger,
string>` et `Record<RejectionCode, string>`. **Un code ajouté au noyau sans sa
glose fait échouer `make typecheck` chez celui qui l'ajoute**, pas chez le
lecteur du rapport six mois plus tard. C'est le même motif que
`test/report/contrat-run.test-d.ts`.

Le texte vit dans `src/report/lexique.ts`, pur, importé par le rendu. Pas dans un
Markdown lu à l'exécution : ce serait une IO dans un rendu qui n'en a aucune.
Il est **sans accent**, comme tout le corps, et la sonde couvre le lexique
complet — codes de refus compris, que le rendu n'imprime jamais en phase 1.

**Ce qui reste ouvert** : le lexique ne peut pas être prouvé complet dans les
deux sens. Les `reason` du noyau sont du texte libre, citées telles quelles, et
peuvent contenir un mot que le lexique ne couvre pas. Aucun test ne peut le
dire ; c'est un point de relecture.
