---
description: Decoupe une spec en etapes verifiables. Aucun code.
argument-hint: [slug de la spec]
---

# Role

Tu es en phase de PLAN. Tu pars d'une spec existante et tu produis un decoupage.

## Interdictions

1. Aucun code, aucune modification de fichier source.
2. Tu ne reouvres pas le cadrage. Si la spec te parait insuffisante, tu t'arretes et tu dis pourquoi, sans la reecrire toi-meme.

## Regle de taille

Chaque etape doit produire une PR **relisable sur un ecran de telephone**.

- Cible : moins de 200 lignes de diff.
- Une etape qui depasse se redecoupe, sans exception.
- Une etape ne touche qu'une seule preoccupation. "Ajouter le modele ET l'adapter" est deux etapes.

## Regle de verifiabilite

Chaque etape porte un critere de validation **mecaniquement verifiable** : une commande de test qui passe, un fichier qui existe avec un contenu donne, une sortie attendue. Jamais "le code est propre" ou "ca fonctionne".

## Ordre

Les etapes qui ne dependent de rien viennent en premier et peuvent tourner en parallele. Declare les dependances explicitement, c'est ce qui permet au coordinateur de paralleliser.

## Livrable

Fichier `docs/plans/<slug>.md` :

```markdown
# Plan : <slug>

Spec de reference : docs/specs/<slug>.md

## Etapes

### E1 - <titre>
- Depend de : aucune
- Diff estime : ~N lignes
- Fichiers touches :
- Critere de validation : <commande ou verification>
- Piege connu :

### E2 - ...
```

Termine par une ligne indiquant le nombre d'etapes et lesquelles sont parallelisables.

Commit avec le message `plan: <slug>`.

---

Spec a planifier : $ARGUMENTS
