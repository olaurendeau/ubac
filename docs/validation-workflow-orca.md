# Validation de la migration Orca — 2026-09-10

## Dépôt

- `npm run typecheck` : réussi.
- `npm test` : 28 tests réussis (un fichier Vitest).
- `git diff --check` : réussi.
- Contrôle documentaire : sept lots, chaque ancienne E4–E24 rattachée une fois,
  C1–C32 présents dans la table de couverture, liens locaux et raccourcis vérifiés.
- Specs métier, source TypeScript et lockfile inchangés.

Node/npm étaient absents du PATH du terminal. Les vérifications utilisent une
installation temporaire de Node 22.23.2 (archive officielle nodejs.org, SHA-256
comparé au manifeste publié). `npm ci --no-audit --no-fund` a réinstallé les
bindings natifs macOS manquants ; le lockfile est conservé. Les futurs workers
nécessitent toujours un Node >= 22 accessible dans leur propre environnement.

## Cycle à blanc : bloqué avant construction

Run : `run_68890cb4508f` — « Validation isolée du workflow Ubac Orca ».
La branche locale et distante `validation/orca-20260910-base` contient un snapshot
des consignes à `11f1e740d5e47ea359f8f399c9c14e67d119666c`. Elle est indépendante
de `main` ; les modifications de migration restent dans le worktree utilisateur.
Le snapshot précède les dernières notes de diagnostic : actualiser ces consignes
avant de reprendre le test.

Worktree créé par Orca :
`/Users/olaurendeau/orca/workspaces/ubac/orca-smoke-20260910`.
Branche de construction : `olaurendeau/orca-smoke-20260910`.
Tâche : `task_872328ef40e4`.

1. Dispatch `ctx_256945809741` : échec `agent_prompt_stalled` à l'injection,
   accueil de confiance du nouveau dossier Claude encore présent. Aucun travail
   produit. Terminal libéré par `worker-release`, archive native capturée.
2. Accueil terminé pour ce worktree vérifié ; reprise explicite du même travail,
   sans recréer de worktree, avec `--retry-of` et un terminal Claude préparé.
3. Dispatch `ctx_144506b48f19` : entrée acceptée (`ready`), puis transcription
   Claude : « You've hit your session limit », réinitialisation annoncée à
   14 h 50, Europe/Paris. Aucun fichier smoke ni PR créé, aucun worker_done.
4. Tentative abandonnée explicitement dans Orca après diagnostic. Le terminal
   préparé est externe au mécanisme de fermeture du dispatch : `worker-stop`
   retourne `stop_unknown`, puis `worker-abandon` enregistre l'abandon sans
   prétendre arrêter le processus. `worker-release` retourne `retained` avec
   `identity_unproven` ; cela ne prouve pas une fermeture.

**Non validés** : construction Claude, détection du défaut par Codex, correction,
revue favorable du nouveau commit et merge vers la branche de test. Ne pas
confondre `ready` ou la création du Run avec un cycle terminé.

## Revue indépendante des consignes

Tâche `task_98b05cd542d3`, dispatch `ctx_220572eee767` : Codex lancé par Orca en
session neuve, revue en lecture seule du diff de migration, d'`AGENTS.md` et des
instructions communes. Verdict PASSE : aucun problème important relevé, reprise
des PR et traçabilité C1–C32 confirmées. Le rapport précise que le cycle smoke
reste non validé ; il ne vaut pas approbation d'une PR au dernier SHA.

Signal `worker_done` accepté, livraison acquittée, terminal libéré par Orca avec
archive de transcription. Le suivi final du Run compte deux terminaux libérés
et un terminal externe conservé ; aucun worker de construction actif. La tâche
smoke est marquée bloquée avec le motif quota et les indications de reprise.
La commande `/exit` adressée au terminal externe a elle-même retourné
`agent_prompt_stalled` : aucune fermeture n'est revendiquée pour ce terminal.

## Réception mobile

Gate `gate_29c802f40be4`, tâche `task_f3beab9d2e7d` : l'opérateur a répondu
« Non, pas visible sur le téléphone ». La gate est résolue avec cette réponse
et le test est enregistré en échec dans Orca. La création native de la gate
est vérifiée, mais sa visibilité mobile ne l'est pas. La cause reste à
diagnostiquer ; cette observation ne permet pas de distinguer un problème de
connexion, de configuration ou de prise en charge des gates par le mobile.
Le pilotage des décisions depuis le téléphone reste donc non validé.

## Reprise

Le relais Cursor a ensuite été autorisé par l’opérateur. Inspecter le Run, les
dispatches et le terminal conservé avant reprise. L’essai Cursor → Codex est
comptabilisé séparément ; il ne transforme pas l’échec Claude en succès. Suivre
le cycle du [kit-workflow.md](kit-workflow.md), sur la branche cible de test uniquement.
Les PR métier #12, #14 et #15 ainsi que les anciens worktrees Linux sont préservés.
