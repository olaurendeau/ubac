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
n'avorte que par `AbortSignal.timeout`, qui lève un `TimeoutError` ; ajouter
l'autre aurait été une promesse qu'aucune sonde ne pouvait tenir. Il tombe en
`INCONNU`.

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
2. **Les nombres sortent entiers ou pas du tout.** Les types sont effacés à
   l'exécution et `HttpSend` est une interface publique : ce qui se présente
   comme un statut peut être une chaîne, donc un jeton. Un non-entier rend `?`.
3. **L'erreur attrapée est classée, jamais lue.** `name` est *comparé* à un
   littéral ; le `message`, la `cause` et la pile ne sont pas lus du tout. Dans
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
module n'aurait jamais vu passer. Vérifié réseau coupé :

```sh
docker run --rm --network none -v "$PWD":/workspace \
  -v ubac-q6-alertes_ubac_node_modules:/workspace/node_modules \
  -w /workspace ubac-q6-alertes-dev npm test
```
