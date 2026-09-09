# Workflow de dev piloté au téléphone

Version 1.0 · OLA Alpine Solutions · Olivier Laurendeau

---

## 1. Objectif

Tester un cycle de développement où l'opérateur ne fait que **décrire un besoin depuis son téléphone**, et où la chaîne outillée se charge du reste :

```
description du besoin
   ↓  cadrage : le workflow interroge et challenge le besoin
   ↓  plan : découpage en étapes vérifiables
   ↓  boucles implémentation / revue automatisées
   ↓  documentation et rapport
```

Ce n'est pas un projet de production, c'est une expérimentation avec des critères d'évaluation explicites (§8). Le projet support est l'agent de rééquilibrage crypto, phases 0 et 1, dont la spec existe déjà et dont l'échec ne coûte rien.

### Ce qui change par rapport à l'existant

Le workflow actuel est Claude Code en remote control depuis l'app mobile. Il fonctionne mais l'opérateur y tient le rôle de bus de messages : il tabule entre les sessions, lit des sorties à moitié terminées, recopie le résultat d'un agent dans le prompt d'un autre. L'expérimentation vise à déléguer cette coordination.

---

## 2. Choix d'outillage

### Retenu : Orca

ADE open source (MIT, Stably AI) qui orchestre plusieurs agents CLI en worktrees git parallèles. Compatible Claude Code, Codex, OpenCode.

Trois raisons :

1. **Skill d'orchestration** : un agent coordinateur dispatche le travail, attend les résultats, et sollicite le téléphone quand il a besoin d'une décision. C'est précisément la boucle recherchée.
2. **App compagnon mobile** (iOS, TestFlight, APK Android) : statut de chaque worktree sur chaque hôte connecté, lecture du scrollback, réponse à un agent en attente par voix ou texte, revue et commit des changements, push à la fin de chaque agent.
3. **Isolation par worktree** : un worktree et une branche par tâche, ce qui rend les boucles parallèles sûres par construction.

### Écarté : OpenHands

Mauvaise forme pour ce besoin. C'est un moteur autonome ticket vers PR : on lui donne une tâche **déjà formulée** et il produit une PR. Toute la phase de cadrage et de challenge, celle qui a le plus de valeur ici, n'existe pas dans ce modèle. Il concurrence Claude Code comme moteur plutôt qu'il ne le complète.

### Reporté : Archon

Serveur MCP faisant base de connaissance RAG et gestion de tâches partagée. Sa valeur apparaît sur un gros existant ou en équipe. Sur un projet greenfield solo dont la spec tient dans un fichier markdown, c'est une pièce mobile de plus sans contrepartie.

**Critère de réintroduction** : le jour où l'opérateur se surprend à réexpliquer le même contexte à plusieurs agents, ou quand plusieurs projets partagent des conventions.

---

## 3. Topologie

```
Téléphone (Orca Mobile)
   │  dictée vocale, validation, revue légère, push
   │  via Orca Relay  ← ne pas dépendre du même réseau local
   ▼
Machine hôte allumée en permanence (Orca desktop = coordinateur)
   │
   ├── agent-vm : une VM Linux par projet, l'agent y est root
   │     └── Claude Code, worktrees git isolés
   │
   └── GitHub : PR = surface de revue de référence
```

### Points de configuration

- **Pairing** : code à usage unique généré côté desktop, saisi sur mobile. Les deux côtés doivent être sur le même compte Orca, et le code expire en quelques minutes.
- **Relay activé** : sans lui, le pilotage ne fonctionne que sur le réseau local. Rédhibitoire pour un usage en déplacement ou en montagne.
- **Isolation** : les agents tournent dans agent-vm, jamais directement sur l'hôte. Un agent autonome qui a le root dans une VM jetable est acceptable ; le même sur la machine de travail ne l'est pas.
- **Secrets** : aucun secret de production dans les worktrees pilotés par agent. Le projet trading manipule des clés Coinbase : elles restent dans les variables secrètes Scaleway, jamais en local.
- **Permissions pré-autorisées** dans les projets, sinon les sessions se bloquent sur des approbations pendant que l'opérateur est loin du clavier.

---

## 4. Les cinq phases

### Phase A : cadrage et challenge

**C'est le trou que l'outillage ne bouche pas.** Orca, OpenHands et les autres partent tous d'une tâche déjà formulée. Cette phase est une skill à écrire, et c'est elle qui porte l'essentiel de la valeur du workflow.

Contraintes non négociables :

| Contrainte | Raison |
|---|---|
| Interdiction absolue d'écrire du code | sinon la phase se dissout dans l'implémentation |
| Questions **numérotées, répondables par un chiffre** | sur téléphone, si l'opérateur doit taper un paragraphe, le workflow meurt |
| Maximum 5 questions par passe | au-delà, l'opérateur décroche |
| Au moins une hypothèse challengée explicitement | c'est la raison d'être de la phase |
| Sortie : `docs/specs/<slug>.md` committé | la spec devient l'artefact de référence de toute la chaîne |

### Phase B : plan

Lit la spec, produit `docs/plans/<slug>.md` : étapes ordonnées, chacune avec son critère de validation vérifiable. Toujours pas de code.

Une étape doit être assez petite pour tenir dans une PR relisable sur un écran de téléphone. Si une étape dépasse ~200 lignes de diff attendues, elle se redécoupe.

### Phase C : implémentation

Un worker par étape, dans son propre worktree. Commit, puis PR. **Une étape par PR**, sans exception.

Le coordinateur enchaîne les étapes dont les dépendances sont satisfaites et bloque sur celles qui attendent une décision humaine.

### Phase D : revue

**Session neuve, contexte vide. C'est le point critique du dispositif.**

Un agent qui relit son propre code valide toujours. Le reviewer doit :

- lire le diff **contre la spec**, jamais contre le plan ni contre l'historique de conversation ;
- ignorer les justifications d'implémentation, qu'il ne doit pas avoir sous les yeux ;
- produire un verdict binaire plus une liste de points bloquants.

Si le coordinateur n'y est pas forcé explicitement, il réutilisera le contexte de l'implémenteur. C'est le mode d'échec le plus probable et le plus silencieux du workflow.

### Phase E : documentation et rapport

En fin de cycle : mise à jour du README et du CHANGELOG, et rapport poussé sur le téléphone. Le rapport contient trois choses et rien d'autre :

1. ce qui a été fait, en une phrase ;
2. ce qui est bloqué ;
3. la prochaine décision attendue de l'opérateur.

Réutiliser la brique ntfy du projet trading. Elle sert deux fois.

---

## 5. Skills à écrire

Quatre fichiers, plus un hook. À placer au niveau projet pour qu'ils soient versionnés avec le code.

| Skill | Rôle | Garde-fou principal |
|---|---|---|
| `cadrer` | interroge et challenge, produit la spec | interdiction d'écrire du code |
| `planifier` | découpe en étapes vérifiables | étapes ≤ 200 lignes de diff |
| `construire` | implémente une étape, ouvre une PR | une seule étape par invocation |
| `relire` | valide le diff contre la spec | session neuve obligatoire |

Hook `Stop` : pousse le rapport trois lignes sur ntfy avec le lien de la PR.

---

## 6. Surveillance et modes d'échec

### Watchdog obligatoire

Des tickets ouverts sur Orca décrivent un `worker-start` où le prompt atterrit dans le composer de l'agent sans jamais être soumis, avec un retour `ok: true` et un état `ready`. Le worker reste idle indéfiniment pendant que le coordinateur croit que le travail a démarré.

Sur une boucle pilotée au téléphone, ce mode d'échec est **silencieux**. Contre-mesure : timeout côté coordinateur. Si un worker n'a produit aucun commit ni aucune sortie après N minutes (démarrer à 15), il alerte sur ntfy.

Vérifier ce comportement en début d'expérimentation, il est susceptible d'être corrigé.

### Autres modes d'échec à surveiller

- **Le reviewer complaisant** : si les revues passent systématiquement du premier coup, le contexte fuit entre l'implémenteur et le reviewer. Vérifier en introduisant volontairement un bug dans une PR.
- **Le cadrage qui ne challenge pas** : si la skill de cadrage se contente de reformuler le besoin, elle ne sert à rien. Le test : sur au moins un cycle sur trois, le cadrage doit avoir modifié le besoin initial.
- **La dérive de scope** : un worker qui déborde de son étape. Le critère de validation de l'étape est le garde-fou.

---

## 7. La limite structurelle

Le goulot d'étranglement de ce workflow n'est pas l'orchestration, c'est **la capacité à relire un diff sur un écran de téléphone**. C'est mauvais et ça le restera, quel que soit l'outil.

Le vrai levier est donc de rendre la revue humaine largement superflue :

- PR minuscules, une étape chacune ;
- tests qui font foi, avec couverture stricte sur les parties critiques ;
- critères de validation écrits dans le plan **avant** l'implémentation.

Sur le projet trading, la couche risque impose déjà ce régime : couverture 100 %, chaque code de rejet testé. C'est ce qui en fait un bon terrain d'essai.

---

## 8. Critères d'évaluation de l'expérimentation

À trancher après trois à cinq cycles complets. Sans ces critères, l'évaluation se fera à l'impression, qui est toujours favorable à l'outil récent.

| Critère | Question | Seuil de succès |
|---|---|---|
| Cadrage utile | le cadrage a-t-il modifié le besoin initial ? | ≥ 1 cycle sur 3 |
| Revue efficace | des points bloquants réels ont-ils été remontés ? | ≥ 1 par cycle |
| Autonomie | combien d'interventions clavier par cycle ? | ≤ 3 |
| Silence | combien d'échecs silencieux détectés ? | 0 après réglage du watchdog |
| Coût cognitif | l'opérateur a-t-il dû rouvrir le laptop ? | à documenter honnêtement |

Le dernier critère est le plus important. Si chaque cycle finit devant le laptop, le workflow ne tient pas sa promesse et il faut le dire.

---

## 9. Séquence de mise en route

| Étape | Contenu | Durée |
|---|---|---|
| 1 | Installer Orca desktop sur l'hôte permanent, appairer le mobile, activer le Relay | 30 min |
| 2 | Écrire les quatre skills et le hook `Stop` | 1 soirée |
| 3 | Cycle à blanc sur une tâche triviale, watchdog inclus | 1 h |
| 4 | Cycle réel : phase 0 du projet trading (`core` + tests) | |
| 5 | Cycle réel : phase 1 (adapters, DB, rapport Brevo) | |
| 6 | Bilan sur les critères du §8 | |

Ne pas sauter l'étape 3. Le cycle à blanc sert à vérifier que le watchdog déclenche et que le reviewer ne complaît pas, pas à produire du code.

---

## 10. Décisions ouvertes

1. **Moteur des workers** : Claude Code partout, ou fan-out multi-moteurs sur les étapes ambiguës pour comparer les résultats ? Orca sait le faire, mais cela multiplie les diffs à trier depuis le téléphone.
2. **Où vit le coordinateur** : dans agent-vm comme les workers, ou sur l'hôte ? Dans la VM est plus propre, sur l'hôte est plus simple à déboguer.
3. **Rapport** : ntfy seul, ou ntfy plus un digest quotidien par mail comme sur le projet trading ? Le digest a du sens si plusieurs cycles tournent en parallèle.
