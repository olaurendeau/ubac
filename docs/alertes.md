# Alertes push

Les alertes de la spec §9, en push immédiat sur **ntfy auto-hébergé**. « Le mail
est un mauvais canal d'alerte : un drawdown le dimanche ne doit pas attendre le
lundi. » Le rapport quotidien Brevo est un autre canal et un autre lot.

Lot **Q6a1** de la phase 1 : **le canal**, et lui seul. La configuration est
validée, le transport est éprouvé, et on peut publier une alerte. **Rien n'en
émet encore** — quel événement mérite un push, et le câblage dans le run
quotidien, arrivent au lot Q6a2. Ce document grandira avec eux.

Deux fichiers, deux rôles :

- `src/adapters/http.ts` — le transport : un POST, un délai, et **aucune
  exception**. Il ne sait pas ce qu'il transporte.
- `src/adapters/notifier.ts` — la publication ntfy. Il ne décide de rien.

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
apprendrait à les ignorer tous. Les sept événements et leur priorité arrivent au
lot Q6a2 ; leurs noms sont déjà figés dans `ALERT_EVENTS`.

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

## 6. Vérifier

```sh
make check      # npm ci + typecheck + test
```

Aucune sonde n'ouvre de connexion : les tests de `http.ts` remplacent `fetch` par
un double, et `openNotifier` reçoit un transport de test. Le délai est éprouvé
sur un **vrai** `AbortSignal.timeout`, pas sur un `TimeoutError` fabriqué que le
module n'aurait jamais vu passer. Une seule sonde remplace cette globale, celle
de la limite déclarée au §3, et c'est pour montrer ce qui arrive quand elle ment.
Vérifié réseau coupé :

```sh
docker run --rm --network none -v "$PWD":/workspace \
  -v ubac-q6-alertes_ubac_node_modules:/workspace/node_modules \
  -w /workspace ubac-q6-alertes-dev npm test
```
