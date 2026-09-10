# Mise en route du workflow Orca

## Sources communes

- `AGENTS.md` : règles du dépôt ; `CLAUDE.md` importe ce socle.
- [workflow-phases.md](workflow-phases.md) : cadrer, planifier, construire, relire.
- [workflow-dev.md](workflow-dev.md) : rôles, supervision, intégration et reprises.
- `.claude/commands/` : raccourcis Claude vers les instructions communes.
- `docs/specs/` et `docs/plans/` : références et lots de travail.

## Préparation

Orca est installé sur le Mac et le dépôt Ubac y est enregistré. Vérifier le
runtime, la disponibilité de Claude/Cursor/Mistral Vibe/Codex et
l'authentification GitHub :

```sh
orca status --json
orca repo list --json
orca skills get orchestration
claude --version
cursor-agent status
vibe --version
codex --version
gh auth status
```

`vibe` doit résoudre vers l'install uv (`~/.local/bin/vibe`), pas Homebrew.
Après installation ou changement de compte : `vibe --setup`, Sign in sur le
compte abonnement, puis un smoke test `vibe -p "Reply with OK only." --agent ask`.
Si une commande diffère, consulter `orca <commande> --help` et le guide embarqué
avec `orca skills get orchestration --full`. Ne pas copier des drapeaux d'une
version distante plus récente. Activer l'orchestration dans les paramètres
expérimentaux si la version installée le demande.

Ne pas installer Node/npm sur le Mac. Le runtime de build/test est Docker
Compose (`docker-compose.yml`, service `dev`) :

```sh
docker --version
docker compose version
make build
make check
```

Le volume nommé `ubac_node_modules` isole `node_modules` du host. Dans un
worktree neuf, `make build` si besoin puis `make ci` (ou `make check`) avant
les vérifications.
Dans Orca desktop, ouvrir le dépôt et un terminal coordinateur Claude ou Codex.
Appairer le mobile et activer le Relay pour le pilotage hors réseau local.
Le coordinateur doit disposer de son identité de terminal Orca ; ne pas emprunter
celle d'une autre session. Ne pas imprimer de code de pairing ni de secret dans
les rapports versionnés. Aucune variable ntfy ni configuration de VM à fournir.

## Lancement d'un cycle

Depuis le terminal coordinateur Orca, donner cette demande :

```text
Coordonne avec l'orchestrateur natif Orca le plan docs/plans/ubac-phase-0.md.
Lis AGENTS.md, docs/workflow-dev.md et les instructions communes des phases.
Reprends les PR existantes rattachées aux lots avant de créer du travail neuf.
Claude construit par défaut, Cursor puis Mistral Vibe le relaie si indisponible,
Codex relit en session neuve ; trois workers maximum.
Les dépendances attendent l'intégration vérifiée. Ouvre des gates pour les
arbitrages métier et applique la politique de merge automatique du workflow.
```

Ce prompt lance du travail métier : ne l'utiliser qu'après le cycle à blanc.
Le coordinateur suit le guide natif ; la séquence de départ est :

```sh
orca orchestration run-create --objective "Ubac phase 0" --json
orca orchestration task-create --spec "<objectif, périmètre, critères et preuves>" --json
orca orchestration worker-start --task <task_id> --worktree new-top-level --repo path:/Users/olaurendeau/workspace/ubac --name <nom-unique> --base-branch origin/main --agent claude --setup run --json
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 60000 --json
```

Remplacer les paramètres entre chevrons avec les identités renvoyées par Orca.
Les dépendances sont les IDs des tâches d'intégration, pas les anciens numéros E.
Un reviewer reçoit le rôle « Relire » et ses arguments directement ; Codex n'a
pas besoin des slash commands Claude. Le coordinateur n'exécute aucun script
shell d'ordonnancement et ne réutilise pas l'ancien scheduler Orca.

## Premier lancement dans un worktree

Un nouveau dossier peut afficher l'accueil de confiance de Claude avant que
la tâche soit injectée. Vérifier qu'il s'agit bien du worktree Ubac attribué et
terminer cet accueil avant d'attendre la disponibilité du TUI. Un retour
`agent_prompt_stalled` signifie que le travail n'a pas forcément commencé.
Inspecter le dispatch et le terminal, conserver le worktree et suivre la reprise
native `worker-start --retry-of <dispatch_id>` uniquement une fois l'ancienne
tentative prouvée terminée. Ne pas lancer une deuxième copie de la tâche en
parallèle. Un terminal préparé peut être attaché avec `--terminal <handle>`, mais reste
externe pour la fermeture automatique : documenter son propriétaire et sa fin.
Le chemin normal `worker-start --agent` permet à Orca de posséder le terminal.
Si une limite de compte est affichée, consigner l'heure de reprise et bloquer la
tâche. Le relais vers Cursor, puis vers Mistral Vibe (`--agent mistral-vibe`) si
Cursor est aussi indisponible, est autorisé selon `workflow-dev.md`, après
preuve de fin de l'ancien agent ; conserver l'historique des échecs amont.

## Cycle à blanc isolé

Créer un Run dédié et une branche cible de test basée sur le commit courant,
puis un worktree Orca distinct pour la construction. Copier les consignes de
migration si elles ne sont pas encore committées, sans copier `.env` ni secrets.
Toutes les PR du test ciblent cette branche jetable, jamais `main`.

1. Écrire une mini-spec : un fichier `smoke/value.txt` contient exactement `OK`
   suivi d'un saut de ligne. Critère : comparaison exacte des octets.
2. Confier à Claude (ou à Cursor / Mistral Vibe pour valider le relais) la
   construction du fichier, son contrôle, le commit et une
   PR vers la cible de test. Après sa fin, injecter un défaut contrôlé (`KO`) dans
   un commit de test distinct. Le reviewer reçoit la spec et le SHA, sans annonce
   du défaut ni conversation de construction.
3. Lancer Codex en session neuve : attendre BLOQUE pour la non-conformité réelle.
   Envoyer les bloquants à une tâche de correction du même constructeur sur la
   même branche.
4. Relire le nouveau SHA dans une autre session Codex. Après PASSE et comparaison
   exacte réussie, intégrer en squash vers la branche de test et vérifier MERGED.
5. Créer une gate demandant à l'opérateur de confirmer qu'elle apparaît sur le
   téléphone. Laisser cette décision en attente tant qu'il n'a pas répondu.
6. Reconsulter tâches et dispatches du même Run : aucun travail terminé ne doit
   être relancé. Libérer les workers terminés et vérifier leur état natif.

Conserver les identités du Run, des tâches/dispatches, les SHA, PR, commandes,
verdicts et états de release dans un compte rendu de validation. Distinguer les
preuves obtenues des vérifications bloquées, notamment la réception mobile.
Préserver les worktrees/branches de test tant qu'ils contiennent une preuve ou
un travail non intégré ; leur nettoyage n'est pas une suppression des anciens
worktrees Linux.

## Transition depuis le kit précédent

Les scripts maison et le hook Stop sont retirés. Les `.env` privés et anciens
rapports/runs ignorés par Git restent préservés, sans être utilisés par Orca.
Aucune crontab n'était installée pour l'utilisateur du Mac lors de l'inspection.
Sur un autre hôte utilisant encore l'ancien kit, retirer son entrée cron avant
de retirer les scripts ; ne pas laisser deux coordinateurs travailler les mêmes PR.
La migration ne démarre ni ne ferme les sessions préexistantes sur d'autres hôtes.

## Résultat du premier essai

Voir le [compte rendu du 2026-09-10](validation-workflow-orca.md) pour les preuves
et les résultats distincts des essais Claude → Codex, Cursor → Codex et, le cas
échéant, Mistral → Codex.
Le défaut de visibilité mobile reste suivi séparément.
