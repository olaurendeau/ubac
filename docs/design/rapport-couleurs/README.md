# Rapport quotidien en couleurs

Artifact : https://claude.ai/artifact/9R8mENsFzYg79d84mfF6nX
Epic : a creer (demande de l'operateur : « plus de couleurs dans le mail pour que ce soit plus lisible »).

Montre : six jours types (normal, bande franchie avec ordres, rejet PRICE_SANITY, alerte drawdown, encadre RECALCUL_AU_MID, encadre resynchronisation), en clair et en sombre simule ; la palette et son sens ; les criteres d'acceptation (S1 a S6).

Mots ajoutes : "ALERTE — ", " — proche", " !" (ecart d'allocation >= 5 pt), « Attention : au moins un ordre n'a pas abouti normalement. Voir les lignes colorees ci-dessus. »

Decisions : vert/rouge reserves a la performance et au verdict ; seuil "proche" 2 pt (ratio 0.10) ; ecart d'allocation ambre a partir de 5 pt ; mouvements non colores ; inline seulement, fond+texte toujours poses ensemble ; pas de texte brut.

Revisions :
- v1 : premiere version.
- v2 : revue changes-requested : fidelite a origin/main (5 colonnes, Quantite, lignes ombre, detail des ordres, mouvements, metriques indisponibles, lexique), textes du run entre crochets, marque « ! » sur l'allocation, etats degrades, test de contraste sur le HTML rendu, risque du mode sombre note, recalcul au mid corrige.

Decisions de l'operateur (2026-11-15). Ce README prevaut sur le bloc « Decisions (en attente de l'operateur) » de la page, qui reste tel que livre :
- A. Decision: l'ecart d'allocation est ambre et suivi de la marque « ! » a partir de 5 points en valeur absolue, neutre en dessous — Reason: la marque redouble la couleur, et le seuil de 5 pt ne signale que ce qui demande un regard.
- B. Decision: « proche » veut dire a moins de 2 points de la borne de cash et a moins de 0.10 de la borne du ratio — Reason: ce sont les seuils illustres par la maquette, et rien dans la spec ne les contredit.
- C. Decision: les mots ajoutes sont acceptes — « ALERTE — », « — proche », « ! » et la phrase de l'encadre ATTENTION — Reason: sans eux la couleur serait seule, et la regle est qu'elle redouble un signe, un mot ou un chiffre.
- D. Decision: aucun fond n'est force sur le corps (BODY) ; la recommandation de la maquette, `background:#ffffff`, est refusee — Reason: le courrier garde le fond que le client lui donne ; le contraste est prouve sur la paire par defaut #16191d sur #ffffff, et la lisibilite en mode sombre automatique reste un risque non verifie, a controler sur un vrai telephone.
- E. Decision: le signe d'une barre du graphe n'est porte que par sa couleur, #1e7a46 / #b3261e — Reason: exception assumee et documentee ; le signe est imprime ailleurs (case P&L cumule, echelle de la note), et chaque barre est controlee a 3:1 sur blanc, contraste d'un element non textuel.
