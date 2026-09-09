# Kit workflow de dev pilote au telephone

Contenu a deposer a la racine du depot.

```
.claude/
  commands/cadrer.md       /cadrer     interroge et challenge, produit la spec
  commands/planifier.md    /planifier  decoupe en etapes verifiables
  commands/construire.md   /construire implemente UNE etape, ouvre une PR
  commands/relire.md       /relire     valide le diff contre la spec
  settings.json            hook Stop
scripts/
  notify.sh                push ntfy
  stop-hook.sh             rapport 3 lignes en fin de session
  watchdog.sh              detection des workers idle
CLAUDE.md                  conventions, format du rapport, regles techniques
```

## Mise en route

1. Copier l'arborescence a la racine du projet.
2. Definir les variables d'environnement sur l'hote :

```bash
export NTFY_URL=https://ntfy.exemple.fr
export NTFY_TOPIC=dev-agents
export NTFY_TOKEN=...            # optionnel
export WORKTREE_ROOT=~/worktrees
export IDLE_MIN=15
```

3. Tester la chaine de notification :

```bash
./scripts/notify.sh "Test" "Fait : rien
Bloque : rien
Decision attendue : aucune"
```

4. Installer le watchdog en cron sur l'hote :

```
*/5 * * * * cd /chemin/projet && ./scripts/watchdog.sh
```

Le watchdog s'appuie sur un fichier marqueur `.orca-started` que le coordinateur doit deposer dans chaque worktree au lancement d'un worker. Sans ce marqueur, il ne surveille rien.

## Cycle a blanc avant tout usage reel

Deux verifications, sur une tache triviale :

1. **Le watchdog declenche.** Poser un `.orca-started` dans un worktree vide et attendre. Une alerte doit arriver.
2. **Le relecteur n'est pas complaisant.** Introduire volontairement un bug evident dans une PR (un prix en `number` flottant fait un bon cas) et lancer `/relire` en session neuve. Si le verdict est PASSE, le contexte a fuite ou la grille est trop molle.

Ne pas passer au travail reel avant que ces deux tests passent.
