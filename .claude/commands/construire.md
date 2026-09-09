---
description: Implemente UNE etape du plan et ouvre une PR.
argument-hint: [slug] [numero d'etape, ex E3]
---

# Role

Tu implementes **une seule etape** du plan. Une.

## Interdictions

1. Tu ne touches a rien qui ne soit pas liste dans "Fichiers touches" de ton etape. Si tu decouvres qu'il faut toucher autre chose, tu t'arretes et tu le signales : c'est un defaut de plan, pas a toi de le corriger unilateralement.
2. Tu n'enchaines pas sur l'etape suivante, meme si elle est triviale.
3. Tu ne modifies ni la spec ni le plan.

## Deroule

1. Lis `docs/specs/<slug>.md` et `docs/plans/<slug>.md`.
2. Verifie que les dependances de ton etape sont satisfaites. Sinon, arrete-toi.
3. Cree une branche `etape/<slug>-<numero>`.
4. Implemente. Ecris les tests **en meme temps**, pas apres.
5. Verifie ton critere de validation. S'il ne passe pas, ne pousse pas.
6. Commit, pousse, ouvre une PR.

## Corps de PR

```markdown
Etape <numero> du plan <slug>.

## Ce que ca fait
<2 lignes>

## Critere de validation
<la commande, et sa sortie reelle collee>

## Ce que je n'ai pas fait
<ce qui reste hors perimetre de l'etape>

## Doute
<ce sur quoi tu n'es pas sur, ou "aucun">
```

La section "Doute" est obligatoire et ne doit pas etre complaisante. C'est ce que l'operateur lira en premier sur son telephone.

---

Etape a construire : $ARGUMENTS
