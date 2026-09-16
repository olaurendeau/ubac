# Alertes push

Les alertes de la spec §9, en push immédiat sur **ntfy auto-hébergé**. « Le mail
est un mauvais canal d'alerte : un drawdown le dimanche ne doit pas attendre le
lundi. » Le rapport quotidien Brevo est un autre canal :
[rapport-quotidien.md](rapport-quotidien.md).

Deux lots de la phase 1, et la séparation des deux est celle des fichiers.
**Q6a1** a posé le canal : la configuration est validée, le transport est
éprouvé, et on peut publier une alerte. **Q6a2** pose ce qui mérite un push et le
greffe dans le run quotidien.

Quatre fichiers, quatre rôles :

- `src/adapters/http.ts` — le transport : un POST, un délai, et **aucune
  exception**. Il ne sait pas ce qu'il transporte.
- `src/adapters/notifier.ts` — la publication ntfy. Il ne décide de rien.
- `src/jobs/alerts.ts` — le **catalogue** : quel fait produit quelle alerte, à
  quelle priorité, dans quel ordre. Module **pur** — aucune IO, aucune horloge,
  aucun envoi. Il prend l'état d'un run et rend une liste d'alertes.
- `src/jobs/daily.ts` — la greffe : il les fait partir, après la dernière
  écriture. Voir [run-quotidien.md](run-quotidien.md).

Cette séparation n'est pas décorative : elle permet d'éprouver « quel événement
déclenche quoi » sans réseau, sans jeton et sans double de transport.

## 1. Huit variables, et pourquoi pas six

Le §10 de la spec fige six variables secrètes. Ce lot en porte **huit**, et
c'est un écart assumé, pas un oubli : `NTFY_TOKEN` seul ne permet de publier
nulle part. ntfy est auto-hébergé (§3), et un serveur auto-hébergé ne se joint
pas sans son adresse.

| Variable | Rôle | Contrôle au démarrage |
|---|---|---|
| `NTFY_URL` | racine du serveur ntfy | URL `https://` obligatoire |
| `NTFY_TOPIC` | nom du topic, seul | `[A-Za-z0-9_-]`, 64 au plus |
| `NTFY_TOKEN` | jeton porteur | non vide |

Les deux nouvelles sont des **secrets de fait** : qui connaît l'URL du topic lit
les alertes. Les poser en constantes du dépôt les aurait rendues publiquement
lisibles ; elles rejoignent donc les six autres dans `src/config/env.ts`, avec
le même traitement — échec au démarrage en nommant la variable, jamais de défaut
silencieux, et **aucun message ne recopie leur valeur**.

Le contrôle de forme du topic n'est pas cosmétique. Un topic qui porte une barre
oblique publierait sur un autre chemin que celui que l'opérateur croit avoir
configuré, et une alerte partie ailleurs ne se distingue pas d'une alerte jamais
partie.

Le compte de ce tableau est celui **de ce lot**, pas celui du dépôt : le rapport
quotidien en a ajouté deux de son côté, pour le même motif et avec le même
traitement ([rapport-quotidien.md](rapport-quotidien.md) section 8). Le total
requis au démarrage est dans [run-quotidien.md](run-quotidien.md) section 2.

**La spec n'est pas modifiée.** L'aligner est une décision de l'opérateur, pas un
ajustement technique. Le dépôt porte déjà deux écarts documentés de cette façon,
dont `MIN_CASH` à 22 % contre 15 %.

## 2. La publication

Un POST **en JSON sur la racine de `NTFY_URL`**, le topic dans le corps. ntfy
accepte aussi le titre et la priorité en en-têtes HTTP, sur `/<topic>` ; c'est le
JSON qui est retenu, parce qu'un en-tête HTTP n'est pas sûr de transporter de
l'UTF-8. Un titre accentué partirait mutilé ou ferait échouer la requête, et une
alerte illisible vaut à peine mieux qu'une alerte absente.

L'URL est prise **telle quelle**, normalisée par `URL`, et le topic ne lui est
pas concaténé : un serveur monté derrière un préfixe de chemin continue donc de
fonctionner, ce qu'un `new URL('/', base)` aurait cassé en silence.

Le jeton ne sort que dans l'en-tête `Authorization` — jamais dans un corps,
jamais dans une URL, jamais dans un message. C'est la section 4 qui dit comment
cette propriété est tenue plutôt que seulement souhaitée.

Les `tags` du message portent deux choses : l'événement, et la **clé
déterministe** de la section 5.

Deux priorités, pas cinq. `urgent` traverse le mode « ne pas déranger »
d'Android ; il est réservé à ce qui ne peut pas attendre le lendemain matin.
Tout mettre en urgent reviendrait à n'avoir qu'un niveau, et l'opérateur
apprendrait à les ignorer tous. Les noms des sept événements sont figés dans
`ALERT_EVENTS` ; leur priorité et leur déclencheur sont la section suivante.

## 2 bis. Les sept événements

Le §9 en nomme six. Un ajout est assumé, et un nom est élargi.

| Événement | Priorité | Se déclenche quand |
|---|---|---|
| `REBALANCE_EXECUTED` | high | un rééquilibrage a été passé |
| `DRAWDOWN` | urgent | la suspension du §6 est active |
| `REBALANCE_TOO_LARGE` | urgent | un rejet porte ce code |
| `RECONCILIATION_DRIFT` | urgent | le run abandonne à l'étape `RECONCILE` |
| `RISK_REJECTED` | high | un verdict est rejeté pour tout autre code |
| `RUN_ABORTED` | urgent | le run abandonne à toute **autre** étape |
| `JOB_FAILED` | urgent | une exception a échappé au run |

`urgent` est réservé à ce qui ne peut pas attendre le lendemain matin — le
capital bouge mal, ou le système ne fait pas son travail. `high` va à ce qui
marche comme prévu et se raconte : un rééquilibrage passé, un garde-fou qui a
mordu.

La table de `src/jobs/alerts.ts` est indexée par `AlertEvent`, donc un événement
ajouté sans priorité ne compile pas ; et c'est son **ordre de déclaration** qui
donne l'ordre d'émission, relu par `Object.keys` plutôt que recopié. Une sonde —
pas un import, `src/jobs/` ne connaissant des adaptateurs que leurs types —
vérifie que ce catalogue et `ALERT_EVENTS` disent la même chose dans le même
ordre.

**`RUN_ABORTED` est ajouté**, et c'est la raison d'être du lot. Le §9 ne prévoit
d'alerte d'abandon que pour la divergence de réconciliation. Or un run abandonné
n'écrit **rien** — ni décision, ni photo — donc depuis la base il est
indistinguable d'un job qui n'a pas tourné. Le cas s'est produit en réel sur le
compte de l'opérateur : portefeuille vide, valeur totale nulle, abandon propre à
l'étape de **valorisation**, aucune trace. Un événement qui n'aurait couvert que
la divergence aurait laissé ce run-là muet. Les deux se **partagent** les
abandons : jamais deux alertes pour un même abandon, jamais zéro.

**`RISK_REJECTED` est plus large que « jambe rejetée »** du §9. La couche risque
rejette aussi au niveau du run, sans indice de jambe — `MIN_CASH` et
`MAX_EXPOSURE` en particulier, qui disent que le portefeuille est hors de ses
propres limites. S'en tenir littéralement à la jambe les aurait rendus
silencieux. Les codes d'un verdict rejeté se partagent donc eux aussi :
`REBALANCE_TOO_LARGE` d'un côté, tous les autres de l'autre, **aucun code deux
fois, aucun perdu**. Les neuf codes de `RejectionCode` sont sondés un par un, et
leur complétude est tenue à la compilation : un dixième code ajouté au noyau sans
être repris dans la sonde ne compile plus.

**`REBALANCE_EXECUTED` est inatteignable en phase 1.** Rien ne s'exécute, donc la
liste d'exécutions que lit `alertsFor` est toujours vide, et `daily.ts` le dit à
l'endroit où il la passe. Le chemin existe et est éprouvé directement ; il
s'alimentera de la table `orders` en phase 3. Une sonde du run le constate dans
l'autre sens : même un rééquilibrage complet déclenché et accepté ne pousse pas
cet événement.

**Le drawdown ne définit pas son propre seuil.** L'alerte part exactement quand
la suspension du §6 est active, et son corps est le texte que porte la ligne de
`decisions` du jour — produit une seule fois par `src/jobs/snapshot.ts`. L'alerte
et la base ne peuvent donc pas raconter deux chiffres différents, et il n'existe
pas un second seuil qui pourrait dériver du premier. Conséquence : la borne est
**incluse** comme au §6, et non « plus de 25 % » comme le §9 pourrait se lire.

### Ce qui n'alerte pas

`verdict.ignored` ne déclenche rien. Une jambe résiduelle de 12 USDC écartée en
`LEG_TOO_SMALL` n'est pas un rejet : c'est le fonctionnement normal, et
`src/core/types.ts` sépare les deux listes précisément pour qu'on ne les confonde
pas. Les confondre donnerait un push quasi quotidien, donc un opérateur qui
apprend à ignorer ses alertes.

**Un run qui conclut sans incident ne pousse rien.** Le silence est le cas
nominal — ce qui est aussi pourquoi il ne suffit pas : un job qui ne **démarre
pas** ne pousse rien non plus, puisqu'aucun code ne tourne pour l'émettre. C'est
le healthcheck externe du §9 — « la surveillance ne doit pas dépendre du système
surveillé » — qui comble ce trou-là, depuis le lot Q6b :
[healthcheck.md](healthcheck.md). Les trois canaux ne se remplacent pas, et le
dernier tranche un cas que les deux autres laissent ouvert — un run abouti dont
l'alerte **ou le rapport** n'est pas parti pingue sans son marqueur, parce que la
panne d'un canal est exactement la panne que ce canal ne peut pas signaler.

## 2 ter. Quand elles partent, et ce que vaut une alerte qui n'est pas partie

**Après le run, jamais pendant.** `runDaily` enveloppe l'enchaînement complet, le
laisse rendre son résultat ou lever, puis alerte sur ce qu'il constate. Une
alerte ne peut donc pas partir sur un état que le run n'aurait finalement pas
écrit, et la dernière écriture précède toujours le premier envoi — une sonde
compare les rangs d'appel plutôt que de croire la phrase.

Les envois sont **séquentiels et dans l'ordre du tableau ci-dessus** : c'est lui
qui met le plus urgent en tête de l'écran verrouillé, et un `Promise.all` le
perdrait.

Sur une exception, `JOB_FAILED` part **puis l'erreur est relevée** telle quelle :
le point d'entrée doit toujours la voir et sortir en 1. Alerter n'est pas
rattraper.

Une exception qui survient **après** le calcul de la photo emporte avec elle un
drawdown déjà connu : le résultat d'abandon porte donc la suspension, et les deux
alertes partent. Sans ce champ, le drawdown de ce jour-là serait perdu.

### La tension, et comment elle est tranchée

Les deux règles se tendent l'une l'autre :

- **Une alerte en échec ne défait rien.** Le run garde son statut, ses quatre
  lignes de `decisions` et sa photo. Le travail est fait ; une panne de ntfy ne
  doit pas le remettre en cause. La panne d'une alerte n'emporte pas non plus les
  suivantes : l'envoi continue, et une sonde l'établit avec un transport qui
  n'échoue que sur le premier envoi.
- **Mais elle n'est pas silencieuse.** Elle laisse sa ligne de journal — `alerte
  X : NON PARTIE — motif` — elle revient dans le compte rendu du run, **le code
  de sortie passe à 1**, et **le ping du healthcheck part sans son marqueur**
  ([healthcheck.md](healthcheck.md) §4).

Le motif : une alerte qui n'est pas partie est un événement que personne ne
verra. La compter comme un succès rendrait le système muet exactement quand il a
quelque chose à dire. Le travail du run et son compte rendu sont deux choses
différentes, et c'est le code de sortie qui porte la seconde.

La règle vit dans `reported()` de `src/jobs/daily.ts`, et non dans le point
d'entrée : rien ne peut importer `daily-main.ts` (A22), donc une règle écrite
là-bas serait une règle sans sonde. Elle lit `toutParti`, **le seul prédicat qui
dise ce qu'est un compte rendu parti** — alertes et rapport ensemble —, et le
pulse du healthcheck lit le même. Deux prédicats voisins auraient divergé, et
c'est celui qu'on ne relit pas qui se serait tu.

Aucun `try` n'entoure l'envoi, et c'est voulu : la garantie « `notify` ne rejette
jamais » vit en **un seul endroit**, `notifier.ts`. Une sonde du run le vérifie
là où ça compte — transport qui lève, run qui tient quand même, quatre lignes
écrites.

**Ce que le journal nomme**, enfin : l'événement de l'alerte **tentée**, lu sur
l'alerte que `alertsFor` vient de fabriquer, et non sur le sort rendu. Le sort
`UNREADABLE` ne porte pas d'événement (section 4 ter), et nos alertes sont
lisibles par construction : le lire là aurait ajouté une branche qu'aucune sonde
n'aurait pu atteindre depuis le run.

## 3. Ce que le transport garantit, et ce qu'il ne dit pas

- **`send` ne rejette jamais** : ni un refus du serveur, ni une panne réseau, ni
  un délai dépassé. La garantie vit en un seul endroit, plutôt que d'être répétée
  à chaque site d'appel où l'oubli d'un seul suffirait à faire tomber un run qui
  a déjà fait son travail. `openNotifier` la redouble pour ne pas dépendre du
  transport qu'on lui passe.
- **Un statut hors 2xx est un échec.** `fetch` rend une réponse pour un 401 comme
  pour un 200 ; ne pas lire `ok` donnerait un canal d'alerte qui se croit vivant
  avec un jeton révoqué — exactement la panne muette que la surveillance existe
  pour éviter.
- **Aucune prose ne traverse ces deux modules.** Voir la section suivante.

**Limite déclarée** : aucune reprise, aucune file. Une alerte, un appel. Une
reprise supposerait de retenir le processus, et le job a cinq minutes (§10). Le
délai d'une requête est de 5 s : l'alerte part après que tout est écrit, elle n'a
pas le droit de retenir le processus.

**Limite déclarée** : `AbortError` n'est pas traité comme un délai. Ce module
n'avorte que par le délai qu'il arme lui-même ; ajouter l'autre aurait été une
promesse qu'aucune sonde ne pouvait tenir. Il tombe en `INCONNU`.

**Limite déclarée** : une panne réseau qui survient dans la même milliseconde que
l'expiration du délai est classée en `DELAI`. Les deux se sont produites ; le
signal tranche pour celle qu'il connaît.

**Limite déclarée** : la plateforme est tenue pour acquise. Tout ce qui précède
tient contre ce qui vient d'un appelant et contre ce qui vient du réseau. Rien
n'y tient contre un **runtime remplacé** : `http.ts` appelle lui-même deux
globales, `fetch` et `AbortSignal.timeout`, et il les croit sur parole — que
`fetch` parle bien au serveur nommé, que le signal s'arme et expire au temps
demandé. Piéger l'une des deux suppose de contrôler déjà le processus, et à ce
moment-là rien de ce qui est écrit ici ne protège quoi que ce soit : ce qui lit
les secrets et ce qui écrit le journal sont tombés avec. C'est une **hypothèse**,
pas une garantie, et le dépôt la déclare plutôt que de prétendre la tenir.

Ce qui est couvert malgré tout : ce que ces globales **rendent** reste traité
comme étranger. La réponse de `fetch` est lue sous le `try` (§4 bis), et la
lecture d'`aborted` sur notre propre signal passe par `aExpire` — trois lignes,
parce qu'une lecture qui lève est une façon de rejeter comme une autre et que
`send` ne rejette jamais. Une sonde le montre : signal piégé, `send` rend
`RESEAU` au lieu de `DELAI`, et rien du piège n'en ressort. Ce qui n'est **pas**
couvert, et ne peut pas l'être d'ici : un `fetch` qui envoie ailleurs, un signal
qui n'expire jamais. Aucune sonde de ce module ne l'attraperait, et aucune ne
prétend le faire.

## 4. Le motif d'échec : une liste de ce qui peut sortir

`AGENTS.md` : « aucun secret en clair dans le dépôt ». La règle ne s'arrête pas
au dépôt — un jeton parti dans un message d'erreur, une trace d'exception ou un
journal est un jeton à révoquer. Un adaptateur qui parle à un service externe
avec un jeton est précisément l'endroit où cela arrive.

La parade **n'est pas** de masquer ce qui ressemble à un secret. Un filtre par
ressemblance ne connaît que les formes qu'on lui a apprises, et il suffit d'une
forme non prévue pour qu'un jeton passe. Ce dépôt l'a déjà écrit pour le lint
C32 : on y déclare [ce qu'un garde-fou attrape](phase-1-frontieres.md), jamais
qu'il attrape tout.

Ici, c'est donc **la sortie qui est bornée** : un échec ne voyage pas en phrase,
il voyage en **variante**.

| Variante | Donnée portée | Motif rendu |
|---|---|---|
| `REFUS` | le statut HTTP | `refus du serveur, HTTP 401` |
| `DELAI` | le délai en ms | `delai de 5000 ms depasse` |
| `RESEAU` | aucune | `echec reseau` |
| `INCONNU` | aucune | `echec de transport` |

Trois propriétés en découlent, et ce sont elles que les sondes tiennent :

1. **`motifDe` est le seul fabricant de chaînes d'échec.** Une variante hors
   liste, et une variante absente, rendent le repli — sans rien recopier.
2. **Les nombres sont bornés à l'entrée, pas seulement à la sortie.** Les types
   sont effacés à l'exécution, `fetch` est une globale et `HttpSend` une
   interface publique : ce qui se présente comme un statut peut être une chaîne,
   donc un jeton. Un non-entier devient `NaN` **avant** d'entrer dans la
   variante, et `motifDe` le rend en `?`. Le borner seulement à l'écriture du
   motif aurait laissé la valeur étrangère dans un champ que le type déclare
   `number` — donc dans tout journal qui sérialise le sort sans passer par
   `motifDe`.
3. **L'erreur attrapée n'est pas lue du tout.** Pas même pour la classer : ni
   `name`, ni `message`, ni `cause`, ni `stack`, ni `toString`. La section
   suivante dit pourquoi cette propriété a dû être reformulée. Dans
   `openNotifier`, le filet rend une **constante**.

Neuf formes de motif portant un jeton sont éprouvées, et aucune ne ressort : côté
exception, le `message`, le `name`, la `cause`, une chaîne jetée telle quelle, un
objet jeté ; côté retour du transport, un statut qui n'en est pas un, un délai
qui n'en est pas un, une variante inventée, et un `reason` en clair — la forme
d'avant ce contrat, celle qui fuyait. La recherche porte sur le message, le nom,
la cause **et la pile** : `JSON.stringify` les laisse tomber et aurait donné une
sonde verte qui ne garantit rien.

**Limite déclarée** : le prix est que le détail d'une panne réseau disparaît. On
sait qu'elle a eu lieu, pas de quelle classe elle était, et un transport cassé ne
se distingue pas d'un autre. Le statut HTTP, lui, passe entier, et c'est celui
qui distingue un jeton refusé d'un serveur injoignable.

## 4 bis. Lire est un acte, pas une lecture

La section 4 bornait **ce qui sort**. Elle ne disait rien de **l'acte de lire**,
et c'est une classe entière qu'elle laissait ouverte.

Lire une propriété exécute son getter. Une version antérieure de ce module
classait avec `error.name === 'TimeoutError'` — un nom *comparé*, jamais recopié,
ce qui semblait suffire. Un objet tiers dont le getter `name` **lève**, avec un
jeton dans ce qu'il lève, faisait alors rejeter `send` en emportant ce jeton ;
une trace d'exception ou une sérialisation plus haut le divulguait. Le jeton ne
sortait pas *par* la sortie bornée : il passait à côté d'elle. Aucun élargissement
de la liste de ce qui peut sortir n'y pouvait quoi que ce soit.

La parade retenue est la plus simple qui tienne : **ne rien lire**. Ce qu'on ne
lit pas ne peut pas lever.

- Le délai ne se déduit plus de l'erreur mais du **signal que ce module a armé
  lui-même** : `aborted` est un booléen porté par un objet de notre fabrication.
  La classification cesse de dépendre de ce qu'un tiers a posé sur ce qu'il jette.
- Le reste se classe par `instanceof`, qui interroge la chaîne de prototypes et
  n'exécute aucun getter. Un `Proxy` dont le piège `getPrototypeOf` lève reste la
  seule façon d'en faire échouer le parcours : ce contact-là est donc **isolé**,
  et le piège échoue en silence vers `INCONNU`.
- Ce qui reste lu ne l'est jamais hors d'un filet. Dans `openHttp`, la requête
  reçue et la réponse rendue par `fetch` sont lues **dans le `try`** : un getter
  qui lève y devient une variante au lieu d'une exception. Dans `openNotifier`,
  les deux seules lectures du sort rendu par le transport injecté — `status` et
  `failure` — sont dans le `try` du filet, et `motifDe` isole de son côté la
  lecture de la variante.

**Dix-sept formes** tiennent ce qui vient du transport, une sonde par forme, et
les sept premières sont éprouvées deux fois — par le transport et par la
publication :

- sur ce qui est **jeté** : un getter qui lève sur `name`, sur `message`, sur
  `cause`, sur `stack`, sur `toString` ; un objet dont **toute** lecture lève ;
  un objet dont la chaîne de prototypes lève — le seul qui atteigne `instanceof` ;
- sur ce que rend `fetch` : un getter qui lève sur `ok`, un getter qui lève sur
  `status`, un statut qui n'est pas un entier ;
- sur une variante donnée à `motifDe` : un getter qui lève sur `kind`, sur
  `httpStatus`, sur `timeoutMs`, et une variante dont toute lecture lève ;
- sur le sort rendu par un transport injecté : lire `status` lève, lire `failure`
  lève.

Aucune ne fait rejeter quoi que ce soit, aucune ne laisse sortir le jeton — ni
dans le motif, ni dans la variante, ni dans une sérialisation du sort rendu — et
toutes retombent sur `INCONNU` ou sur la constante. Une dix-septième sonde ferme
la boucle dans l'autre sens : un vrai délai qui expire **en jetant un objet
illisible** reste classé `DELAI`, ce qui montre que la classification ne dépend
plus de ce qu'on lit.

## 4 ter. L'alerte est étrangère aussi

Le transport n'est pas le seul objet que `notifier.ts` n'a pas fabriqué :
l'**`Alert`** en est un autre, et elle entre par la porte principale.

Une version antérieure de ce document déclarait l'alerte hors du filet, au motif
que sa forme est déclarée par le module et qu'elle serait remplie par un job à
venir. **L'argument ne tenait pas.** Il s'appuyait sur un fichier absent du dépôt,
donc sur rien qu'un relecteur puisse vérifier ; et il était faux de toute façon,
puisque `notify` et `alertKey` sont exportées et acceptent l'alerte de n'importe
quel appelant. `alertKey` lisait cinq champs **hors** du `try`, plus un
`champ.length` par champ : un getter qui lève en citant un secret y faisait
rejeter `notify` en emportant ce secret — exactement la classe fermée deux fois
au-dessus, revenue par un troisième chemin.

La parade est celle qui marchait déjà, appliquée au bon objet : **lire une seule
fois, sous filet, et borner ce qu'on a lu**.

- `lireAlerte` est le **seul** endroit du module qui touche à l'objet reçu. Le
  `try` couvre la lecture des cinq champs : un getter qui lève devient
  `undefined`, jamais une exception qui remonte, et rien de ce qu'il a jeté n'est
  lu.
- Ce que la lecture rend est ensuite **borné**, parce qu'une valeur qui ne lève
  pas peut quand même être étrangère : l'événement et la priorité doivent
  appartenir à leur vocabulaire, les trois autres champs doivent être des
  chaînes. Sans ce second contrôle, `champ.length` rouvrait dans l'encodage de la
  clé la porte que la lecture isolée venait de fermer.
- Tout le reste du module travaille sur la **copie**, y compris le `catch` et
  les trois sorts rendus. Une propriété déjà lue est une valeur, et une valeur ne
  lève pas.
- Une alerte illisible **ne part pas** : le transport n'est pas appelé. On n'a
  rien de sûr à mettre dans le message.

**Dix-neuf formes** tiennent cette section, une sonde par forme, et chacune est
éprouvée deux fois — par `notify` et par `alertKey`, qui est exportée et lit donc
l'alerte de son côté :

- douze où **lire** lève ou n'a rien à lire : un getter qui lève sur `event`, sur
  `priority`, sur `runDate`, sur `title`, sur `body` ; un objet dont toute
  lecture lève ; un objet dont la chaîne de prototypes lève ; un objet dont
  **seule** la chaîne de prototypes lève — il montre que ce module ne parcourt
  jamais le prototype d'une alerte ; et quatre valeurs qui ne sont pas des objets
  — une chaîne, un nombre, `null`, `undefined` ;
- sept où la lecture réussit mais rend autre chose que ce qu'`Alert` déclare : un
  événement inconnu, un événement qui n'est pas une chaîne, une priorité
  inconnue, une priorité qui n'est pas une chaîne, un jour de run qui n'est pas
  une chaîne, un corps qui n'est pas une chaîne, et un titre dont la **longueur**
  lève — celui-là ne tombe que grâce au bornage.

Aucune ne fait rejeter, aucune ne publie, et rien de l'objet reçu ne ressort : ni
dans le motif, ni dans la clé, ni par une exception qui aurait emporté sa trace.
L'égalité des sondes porte sur le sort **entier**, pas sur l'absence du jeton :
elle interdit tout champ qui porterait quoi que ce soit de l'appelant. Remettre
une lecture nue dans `alertKey` fait tomber dix-neuf sondes ; la remettre dans
`lireAlerte` en fait tomber trente-huit.

**Le prix, dit franchement.** `AlertOutcome` gagne un troisième sort,
`UNREADABLE`, et c'est le seul qui ne porte pas d'événement — il n'y en a pas eu
à lire. Deux alertes illisibles ne se distinguent donc pas l'une de l'autre, et
une sonde le constate. Les deux autres options étaient pires : inventer un
événement, ou recopier celui de l'appelant, c'est-à-dire faire ressortir l'objet
même qu'on a refusé de lire. `alertKey` rend de son côté la constante
`cle-illisible`, qu'aucun digest ne peut produire — `illisible` n'est pas de
l'hexadécimal.

**Ce qui reste non couvert, dit franchement.** Un seul point dans ce module, et
ce n'est pas l'alerte : les **secrets**, lus une fois à la construction par `openNotifier`
— l'URL, le topic, le jeton. Cette lecture-là a le droit de lever, et c'est
voulu : une configuration invalide doit échouer bruyamment au câblage, pas à la
première alerte, quand il est trop tard pour le dire. Ce qui l'assure n'est pas
une promesse faite à un appelant ni un fichier à venir, c'est
[`loadConfig`](../src/config/env.ts), présent aujourd'hui, qui construit l'objet
`Secrets` lui-même, champ par champ, à partir de valeurs déjà validées (§1).
Passé la construction, `notify` n'en lit plus rien.

## 5. Écart assumé avec la règle d'idempotence

`AGENTS.md` : « toute opération extérieure doit être idempotente », sans
exception. **Ce POST ne l'est pas**, et ntfy ne déduplique pas côté serveur.

**Ce que ça coûte, dit franchement** : un rejeu du même jour renvoie les mêmes
alertes, et l'opérateur reçoit deux fois la même notification.

### Pourquoi l'écart est retenu plutôt que levé

Une idempotence **pleine** demanderait de retenir les alertes déjà envoyées :
une table, et une lecture avant chaque envoi. Personne ne l'a spécifiée pour ce
lot, et elle appartiendrait au lot des événements, voire plus tard.

Le coût est **bénin ici, et nulle part ailleurs**. Deux notifications identiques
se lisent comme un doublon : l'opérateur voit le même texte deux fois et
comprend. Deux ordres ne se lisent pas comme un doublon — ils s'exécutent.
L'écart ne s'étend donc à aucune autre opération extérieure, et surtout pas à
celles de l'exécution, où `clientOrderId` (§7) porte déjà la garantie que ce
module n'a pas.

### Ce qui est fait à la place : une clé déterministe

Chaque message porte `sha256(domaine | run_date | événement | titre | corps)`,
tronquée à 12 hexadécimaux et préfixée `cle-`. Même alerte le même jour, même
clé ; une composante qui bouge, clé différente.

Elle ne déduplique rien, elle rend le doublon **reconnaissable** : par un humain,
dans les `tags` du message, que les clients ntfy affichent sous la notification ;
par un traitement ultérieur, dans l'`AlertOutcome` rendu à l'appelant — `SENT`
comme `FAILED` —, donc dans les journaux.

L'encodage est **préfixé par longueur**, comme `clientOrderId` : la collision
entre deux alertes distinctes devient impossible par construction, au lieu de
reposer sur l'absence d'un séparateur dans un titre libre. Le domaine
`ubac.alert-key.v1` dit qu'un changement d'encodage est une rupture, et une sonde
fige la valeur attendue pour que la faire bouger reste un acte conscient.

### Ce qui lèverait l'écart

Une **table des alertes émises**, indexée sur cette clé, lue avant chaque envoi —
le rôle que l'index unique de `decisions` joue pour le run quotidien (voir
[base-de-données](base-de-donnees.md)). La clé est déjà la bonne : le jour où
cette table existera, l'écart se lève sans changer un octet de ce qui part sur le
réseau.

## 5 bis. Écart assumé avec le §3 : un canal public, non authentifié

**Ce que la spec dit.** Le §3 prévoit un ntfy **auto-hébergé**, et le §10 fige
`NTFY_TOKEN` parmi les variables secrètes. Le canal d'alerte y est authentifié.

**Ce que le code fait.** `NTFY_TOKEN` accepte, en plus d'un jeton porteur, la
sentinelle `CANAL-PUBLIC-SANS-JETON`. Elle déclare un canal **non
authentifié** : `loadConfig` rend alors `ntfyToken: null` et `openNotifier`
publie **sans en-tête `Authorization`** — pas un en-tête vide, pas d'en-tête du
tout, un `Bearer ` sans jeton valant un 401 qu'on confondrait avec un jeton
révoqué.

**Pourquoi.** Le topic de l'opérateur vit sur ntfy.sh, public et sans liste de
contrôle d'accès. Réserver un topic y est une option payante : un jeton de
compte gratuit authentifierait le publieur sur un canal que n'importe qui peut
lire et alimenter. Il n'achèterait donc presque aucune sécurité, et il en
donnerait l'apparence. **Mieux vaut un système qui dit qu'il est ouvert qu'un
système qui fait semblant d'être authentifié** — décision de l'opérateur du
2026-09-16.

**Ce que l'écart ne desserre pas.** `NTFY_TOKEN` absente, vide ou blanche reste
refusée au démarrage, en nommant la variable : une variable posée mais vide est
plus dangereuse qu'absente, et c'est le défaut même que `src/config/env.ts`
existe pour fermer. Une sentinelle **mal orthographiée** — casse, espace de
copier-coller — est refusée elle aussi, plutôt que d'être lue comme un jeton qui
vaudrait un 401 par jour sans jamais dire que la faute est une majuscule. Le
compte des dix variables requises ne bouge pas.

**Ce que l'écart coûte, dit franchement.** Qui connaît le nom du topic peut lire
les alertes, et peut en publier de fausses.

**Ce qui le lève, et avant quand.** Un topic réservé, un compte avec ACL, ou le
serveur auto-hébergé du §3. **Avant la phase 3**, et l'échéance n'est pas
décorative : aujourd'hui rien ne s'exécute, donc une fausse alerte injectée ne
fait au pire agir personne. En phase 3, où des ordres partent, une fausse alerte
pourrait faire agir l'opérateur — et c'est un tout autre coût.

**En attendant, le run le dit tous les jours.** `runDaily` journalise
`NTFY_CANAL_OUVERT_LIGNE` en première ligne, avant le premier appel de port,
donc y compris sur un run qui va lever. Une ligne quotidienne se voit passer ; un
document se lit une fois. La procédure de déploiement porte la même mention dans
ses prérequis : [deploiement.md](deploiement.md) section 1.

## 6. Vérifier

```sh
make check      # npm ci + typecheck + test
```

Aucune sonde n'ouvre de connexion : les tests de `http.ts` remplacent `fetch` par
un double, et `openNotifier` reçoit un transport de test. `test/jobs/alerts.test.ts`
n'ouvre rien du tout et ne connaît pas ntfy — c'est un module pur. Les sondes du
§9 dans `test/jobs/daily.test.ts` montent le **vrai** `openNotifier` sur un
transport double : un double de `Notifier` aurait sondé le câblage sans sonder ce
qui part, alors qu'ici le corps JSON réellement publié est relu. Le délai est éprouvé
sur un **vrai** `AbortSignal.timeout`, pas sur un `TimeoutError` fabriqué que le
module n'aurait jamais vu passer. Une seule sonde remplace cette globale, celle
de la limite déclarée au §3, et c'est pour montrer ce qui arrive quand elle ment.
Vérifié réseau coupé :

```sh
docker run --rm --network none -v "$PWD":/workspace \
  -v ubac-q6-alertes_ubac_node_modules:/workspace/node_modules \
  -w /workspace ubac-q6-alertes-dev npm test
```
