# Healthcheck externe

La surveillance d'absence de la spec §9, en **pulse updown.io**. « La
surveillance ne doit pas dépendre du système surveillé » : tout ce qui suit
découle de cette phrase, y compris ce que ce lot refuse de faire.

C'est le canal **inversé**. Les alertes de [alertes.md](alertes.md) parlent quand
quelque chose se produit ; ici, c'est le **silence** qui alerte. Un job qui ne
démarre pas ne pousse aucune alerte — aucun code ne tourne pour l'émettre — et
depuis la base il est indistinguable d'une journée sans rien à faire. C'est le
trou que ce lot comble, et il ne peut le combler que de l'extérieur.

Deux fichiers, deux rôles :

- `src/adapters/healthcheck.ts` — le pulse : une URL, un POST, un corps, et
  **aucune exception**. Il ne décide rien de ce que le run a conclu.
- `src/jobs/daily.ts` — la greffe : `pulseOf` traduit ce que le run a conclu,
  `signal` envoie et journalise. Voir [run-quotidien.md](run-quotidien.md).

Le transport est `src/adapters/http.ts`, celui des alertes. Un second client
aurait divergé, et c'est celui qui n'a pas été relu qui fuit.

## 1. Une URL, toujours un POST, et c'est le corps qui parle

updown.io conserve le corps d'un pulse et l'affiche pour investiguer une panne.
Il sait aussi y **chercher une chaîne** — champ « contains » dans l'interface,
paramètre `string_match` de l'API. Chaîne absente, **ou corps absent** : le check
est considéré `DOWN`, exactement comme un ping manquant.

Il n'y a donc ni suffixe d'URL ni paramètre de requête à inventer : une seule
URL, toujours un POST, et la différence voyage dans le corps. La contrainte de
`http.ts` — POST uniquement — tombe d'elle-même.

L'URL est prise **telle quelle**, normalisée par `URL`, et rien ne lui est
concaténé : `HEALTHCHECK_URL` est une URL de pulse complète, pas une racine de
service.

## 2. La condition de réception, et elle est côté opérateur

> Le check updown doit être configuré avec la **chaîne recherchée égale à
> `RUN_CONCLU`**.

Sans elle, le corps n'est pas inspecté, tout pulse compte comme un pulse, et un
**run abandonné passerait pour un succès**. C'est la seule panne de ce lot qui ne
laisse aucune trace : le job ping, updown répond `UP`, et personne ne sait que
rien n'a été écrit.

**Le code ne peut pas la garantir**, et il ne prétend pas le faire. Il n'existe
aucune requête que le job pourrait faire pour vérifier la configuration du check
sans lui donner une clé d'API supplémentaire — c'est-à-dire sans faire dépendre
la surveillance d'un secret de plus du système surveillé. C'est une **condition
de réception**, à vérifier une fois à la main, et elle est écrite ici comme
telle.

La valeur ne se recopie pas : elle est exportée en `RUN_MARKER` depuis
`src/adapters/healthcheck.ts`, et aucune sonde ne la réécrit en littéral. Deux
littéraux divergent, et c'est celui qui n'a pas de sonde qui gagne.

## 3. Les trois fins

| Fin du run | Ping | Corps | Lu par updown |
|---|---|---|---|
| conclu **et** rendu compte | oui | `RUN_CONCLU` + `run_date`, `git_sha`, `decisions`, `alertes` | `UP` |
| abandonné | oui | `RUN_ABANDONNE` + `etape`, `code` | `DOWN` |
| conclu, alerte ou rapport non parti | oui | `RUN_NON_RENDU` + `alertes_non_parties`, `rapport_non_parti` | `DOWN` |
| **exception** | **non** | — | `DOWN` par absence |

Le troisième cas couvre **les deux canaux du compte rendu**, et le corps dit
lequel a manqué : `alertes_non_parties=0` avec `rapport_non_parti=oui` est le cas
le plus probable des trois, ntfy et Brevo n'ayant aucune raison de tomber
ensemble. L'opérateur qui voit sonner updown doit pouvoir dire s'il lui manque
une alerte ou son courrier du matin : ce ne sont ni la même cause ni la même
urgence.

Un **abandon pingue**, et c'est la moitié de la règle qu'on oublie : le job a
tourné, il n'a simplement pas abouti. La différence doit se voir côté
surveillance — updown lit `DOWN` dans les deux cas, mais le corps dit laquelle
des deux pannes a eu lieu, et c'est ce qui épargne une investigation.

### Pourquoi une exception ne pingue pas du tout

C'est le point le plus important du lot, et c'est une **absence de code** qui le
tient : le motif complet est au `throw` de `runDaily`, la seule ligne du dépôt
dont l'absence de code est la fonctionnalité.

En bref : un ping d'échec est une **affirmation** — « j'ai tourné, je n'ai pas
abouti » — et la formuler suppose que le code a survécu assez loin pour la
décider. Une exception ne l'offre pas, un processus tué ou une mémoire épuisée
encore moins. L'absence de ping, elle, a la propriété qu'aucune ligne de code
n'aura jamais : **elle ne demande à rien de fonctionner**. Un job qui ne démarre
pas, un job tué à la deuxième étape et un job qui lève produisent le même
silence, lu de l'extérieur.

Trois exceptions levées à trois profondeurs — avant la première lecture, au
milieu des lectures, après la dernière écriture — sont sondées une par une :
« aucun chemin » se sonde en les prenant un par un, pas en croyant la phrase.

Le ping vient **en dernier** parce qu'il rapporte ce que le run a *fait savoir*,
et les deux canaux en font partie : les alertes, puis le rapport Brevo
([rapport-quotidien.md](rapport-quotidien.md)). Le placer avant l'envoi du
rapport l'obligerait à pinguer sur un courrier pas encore parti, donc à affirmer
« tout est rendu » sans l'avoir seulement tenté — la seule façon de dire qu'un
rapport n'est pas parti est d'avoir essayé de l'envoyer d'abord. L'ordre du run
est donc **alertes, rapport, ping**, et `test/jobs/daily.test.ts` le sonde cran
par cran.

## 4. La tension, et comment elle est tranchée

Deux règles déjà posées se tendent l'une l'autre : « le run est un succès si et
seulement si son compte rendu est parti » ([alertes.md](alertes.md) section 2 ter,
[rapport-quotidien.md](rapport-quotidien.md) section 2 ter) et « un compte rendu
en échec ne fait pas échouer le run ». Que vaut, pour le healthcheck, un run
abouti dont l'alerte — ou le rapport — n'est pas partie ?

**Il pingue sans le marqueur**, sous son propre état `RUN_NON_RENDU`.

Le motif tient en une phrase : **la panne d'un canal est exactement la panne que
ce canal ne peut pas signaler.** Si ntfy est tombé, le canal court est muet par
définition ; si Brevo est tombé, le canal long l'est aussi, et le catalogue des
sept événements n'a volontairement pas d'entrée pour « rapport non envoyé ». Le
healthcheck est le seul canal restant qui ne dépende ni de l'un ni de l'autre. Se
taire là reviendrait à faire dépendre la surveillance du système surveillé —
c'est-à-dire à perdre la raison d'être du lot.

C'est le **même prédicat** que le code de sortie, `toutParti` dans `daily.ts`, et
ce n'est pas une coïncidence : deux prédicats voisins auraient divergé, et c'est
celui qu'on ne relit pas — le ping, parti chez un tiers — qui se serait tu le
jour où il fallait qu'il parle.

### Un seul prédicat, et la suite qui l'interdit de se dédoubler

Les deux greffes ont été posées en deux fois : les alertes d'abord (Q6a2), le
rapport ensuite (Q5b), le healthcheck entre les deux (Q6b). À la fusion, chacune
apportait sa version de « le compte rendu est-il parti » — le code de sortie
voyait le rapport, le pulse ne le voyait pas. Un échec Brevo aurait alors pingué
**avec** le marqueur pendant que le déclencheur lisait 1 : `UP` d'un côté, rouge
de l'autre, sur le même run. Les deux ont été ramenées à `toutParti`, et
`describe('§9 — le code de sortie et le marqueur ne divergent pas')` énumère les
six fins qu'un run peut rendre en nommant les deux verdicts à la main, plutôt
qu'en dérivant l'un de l'autre.

| Fin du run | `reported()` | marqueur | corps |
|---|---|---|---|
| conclu, tout parti | `true` | présent | `RUN_CONCLU` |
| conclu, une alerte perdue | `false` | absent | `alertes_non_parties=1`, `rapport_non_parti=non` |
| conclu, rapport perdu | `false` | absent | `alertes_non_parties=0`, `rapport_non_parti=oui` |
| conclu, les deux perdus | `false` | absent | `alertes_non_parties=1`, `rapport_non_parti=oui` |
| abandonné | `false` | absent | `RUN_ABANDONNE` |
| conclu, **ping** perdu | `true` | présent (dans un corps qui n'est pas parti) | — |
| exception | sort en 1 par la levée | aucun ping | — |

La dernière ligne avant l'exception est l'asymétrie de la sous-section suivante,
et elle est la seule où un échec ne se voit dans aucun des deux verdicts.

Rien n'est défait pour autant. Les quatre lignes de `decisions` et la photo
restent écrites, le statut reste `COMPLETED`. Ce que le pulse rapporte n'est pas
« le travail a échoué », c'est « ce run n'a pas rendu compte » — d'où un état à
lui plutôt qu'un abandon simulé, qui enverrait l'opérateur chercher une panne qui
n'existe pas.

### L'asymétrie inverse : un ping raté ne change pas le code de sortie

Une alerte ou un rapport non parti fait sortir en **1**. Un ping non parti,
**non**, et c'est décidé, pas oublié.

L'asymétrie est réelle. Un compte rendu qui n'est pas parti — une alerte que
personne ne verra, une journée que personne ne lira — ne laisse rien derrière
lui, donc quelque chose doit porter sa trace, et c'est le code de sortie. Un ping
qui n'est pas parti, lui, **se signale tout seul** : son absence est précisément
ce qui fait sonner updown.io. Le mécanisme de surveillance couvre déjà son propre
échec.

Mais il ne doit pas être **muet** : le ping laisse sa ligne de journal —
`healthcheck : NON PINGUE — motif` — et son sort revient dans `RunReport.ping`.
Sans elle, l'opérateur verrait updown sonner sans pouvoir dire si le job est mort
ou si c'est le ping qui n'a pas abouti.

Aucun `try` n'entoure l'appel, et c'est voulu : la garantie « `ping` ne rejette
jamais » vit en **un seul endroit**, `healthcheck.ts`. Une sonde le vérifie là où
ça compte — transport qui lève, run qui tient quand même, quatre lignes écrites.

## 5. L'URL est un secret de fait

Qui connaît l'URL du pulse peut envoyer de faux pings et **masquer un job mort** —
la panne exacte que ce module existe pour rendre visible. Elle est traitée comme
`NTFY_TOKEN` : validée par `src/config/env.ts`, jamais en clair dans le dépôt, et
elle ne sort **ni dans un journal, ni dans un message d'erreur, ni dans une
trace**.

La propriété ne tient pas à la vigilance, mais au même mécanisme qu'au §4 de
[alertes.md](alertes.md) : ce module ne fabrique **aucune** chaîne d'échec, et
chaque champ du corps est borné à l'alphabet `[A-Za-z0-9_-]`, tronqué à 64
caractères. Des sondes balaient la sérialisation entière des sorts et des corps ;
la chaîne secrète n'y figure nulle part.

**Le corps ne porte aucune donnée de marché ni de portefeuille** : ni prix, ni
quantité, ni valeur. Il part chez un tiers qui le conserve, et une panne se
diagnostique très bien sans savoir combien vaut le portefeuille. C'est aussi
pourquoi la cause d'un abandon voyage en **code** (`etape`, `code`) et non en
prose : le `reason` que porte `DailyAbort` cite des montants et des actifs.

### Le marqueur ne fuit pas dans un corps d'échec

`git_sha` vient de la ligne de commande, donc d'un humain ou d'un script. Un
`--git-sha=RUN_CONCLU` ferait lire un abandon comme un succès — la seule façon de
rater une panne **en pingant**.

`corpsDe` vérifie donc le corps **assemblé** et écarte celui qui porterait le
marqueur à tort. Le contrôle ne dépend pas de l'exhaustivité de la liste des
champs, ni aujourd'hui ni demain ; ce n'est pas un filtre par ressemblance, le
seul motif qu'il connaît étant une constante du fichier, comparée à l'identique.

**Limite déclarée** : le détail de l'abandon est perdu avec le corps écarté.
C'est le bon côté de l'échange — un `git_sha` illisible coûte une investigation,
un faux `UP` coûte la panne entière.

## 6. Limites déclarées

- **La configuration du check n'est pas vérifiable par le code** (section 2).
  C'est la limite principale de ce lot.
- **Aucune reprise, aucune file.** Un run, un ping. Une reprise supposerait de
  retenir le processus, et le job a cinq minutes (§10). Le délai d'une requête
  est de 5 s, hérité de `http.ts`.
- **Le corps ne porte pas de durée.** L'horloge est injectée et `instant()` est
  volontairement figée pour tout le run, afin que `decisions.created_at` soit
  stable ; une durée calculée dessus vaudrait toujours zéro. Mieux vaut pas de
  donnée qu'une donnée fausse.
- **La plateforme est tenue pour acquise**, comme pour `http.ts` : voir
  [alertes.md](alertes.md) section 3. Un `fetch` qui enverrait ailleurs n'est
  attrapé par aucune sonde d'ici, et aucune ne prétend le faire.
- **Ce lot ne surveille que le run quotidien.** Un second job — la liquidation,
  la réconciliation hors run — n'a pas de pulse, et n'en aura que si quelqu'un
  décide qu'il en faut un.
