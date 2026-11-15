/**
 * Ce que les tests du rapport savent lire dans son HTML : le texte, ligne a
 * ligne, et les couleurs, element par element. Module d'aide, sans test propre :
 * `daily-report.test.ts` le fait mordre, sondes a l'appui (precedent :
 * `test/jobs/doubles.ts`).
 *
 * Les calculs de luminance sont en `number` : une couleur n'est ni un prix, ni
 * une quantite, ni un poids.
 */

// --- Le texte ---------------------------------------------------------------

/**
 * Le texte du rapport, cellule par cellule. Les separateurs sont poses avant que
 * les balises ne tombent : sans eux, deux cellules voisines se recolleraient et
 * une valeur disparaitrait dans la suivante sans qu'aucune assertion ne bronche.
 */
export const ENTITES: Readonly<Record<string, string>> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

const decoder = (texte: string): string =>
  texte.replace(/&(amp|lt|gt|quot|#39);/g, (entite) => ENTITES[entite] ?? entite);

export function lignes(html: string): readonly string[] {
  return decoder(
    html
      .replace(/<\/t[dh]>/g, ' | ')
      .replace(/<\/(tr|p|h1|h2|div|table)>/g, '\n')
      /* Apres la chute des balises, et pas avant : sinon un `&lt;b&gt;` echappe redeviendrait une balise et disparaitrait a son tour. */
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((ligne) => ligne.replace(/\s+/g, ' ').replace(/\s*\|\s*$/, '').trim())
    .filter((ligne) => ligne.length > 0);
}

/**
 * Les quatre mots que la couleur ajoute au texte, et eux seuls (decision C).
 * Liste fermee : une cinquieme regle serait une decision, pas un ajustement.
 * Appliquee au texte d'aujourd'hui elle ne change rien ; appliquee au texte colore
 * elle le ramene a celui d'aujourd'hui.
 */
export const ENCADRE_ATTENTION =
  "Attention : au moins un ordre n'a pas abouti normalement. Voir les lignes colorees ci-dessus.";

export function sansMotsAjoutes(texte: readonly string[]): readonly string[] {
  return texte.flatMap((ligne) => {
    if (ligne === ENCADRE_ATTENTION) return [];
    if (ligne.startsWith('ALERTE — ')) return [ligne.slice('ALERTE — '.length)];
    if (ligne.startsWith('Bande de ') && ligne.endsWith(' — proche')) return [ligne.slice(0, -' — proche'.length)];
    if (/^(BTC|ETH|USDC) \| /.test(ligne) && ligne.endsWith(' !')) return [ligne.slice(0, -' !'.length)];
    return [ligne];
  });
}

// --- Le parcours ------------------------------------------------------------

export interface Texte {
  readonly texte: string;
  readonly couleur: string;
  readonly fond: string;
}

export interface Balise {
  readonly nom: string;
  /** Les declarations de son `style`, nom de propriete exact, valeur telle qu'ecrite. */
  readonly style: ReadonlyMap<string, string>;
  /** Un texte non vide est ecrit dans cet element ou l'un de ses descendants. */
  aTexte: boolean;
}

export interface Parcours {
  readonly textes: readonly Texte[];
  readonly balises: readonly Balise[];
}

/** La paire que rien ne vient changer : le corps du rapport ne pose aucun fond. */
export const COULEUR_PAR_DEFAUT = '#16191d';
export const FOND_PAR_DEFAUT = '#ffffff';

const VIDES = new Set(['br', 'hr', 'img', 'input', 'link', 'meta']);

/**
 * `property:valeur` separes par `;`. Le nom est compare en entier : `border-left`
 * ou `background-color` ne sont ni `color` ni `background`, meme quand leur valeur
 * est un `#rrggbb`.
 */
function declarations(style: string): ReadonlyMap<string, string> {
  const declarees = new Map<string, string>();
  for (const declaration of style.split(';')) {
    const coupure = declaration.indexOf(':');
    if (coupure < 0) continue;
    declarees.set(declaration.slice(0, coupure).trim().toLowerCase(), declaration.slice(coupure + 1).trim());
  }
  return declarees;
}

/**
 * Parcourt le HTML avec une pile de balises. `<br>` n'a pas de balise fermante ;
 * toute autre fermeture doit correspondre a l'ouverture en haut de la pile, et
 * toute ouverture doit etre fermee : un rendu mal forme echoue ici, avant que
 * les couleurs n'en soient lues de travers.
 */
export function parcourir(html: string): Parcours {
  const pile: Balise[] = [];
  const balises: Balise[] = [];
  const textes: Texte[] = [];
  const nearest = (propriete: string, defaut: string): string => {
    for (let rang = pile.length - 1; rang >= 0; rang--) {
      const valeur = pile[rang]?.style.get(propriete);
      if (valeur !== undefined) return valeur;
    }
    return defaut;
  };

  for (const [, fermeture, nom, attributs, brut] of html.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>|([^<]+)/gi)) {
    if (brut !== undefined) {
      const texte = decoder(brut).trim();
      if (texte.length === 0) continue;
      for (const ouverte of pile) ouverte.aTexte = true;
      textes.push({ texte, couleur: nearest('color', COULEUR_PAR_DEFAUT), fond: nearest('background', FOND_PAR_DEFAUT) });
      continue;
    }
    const balise = (nom ?? '').toLowerCase();
    if (fermeture === '/') {
      const haut = pile.pop();
      if (haut?.nom !== balise) throw new Error(`</${balise}> ferme ${haut === undefined ? 'rien' : `<${haut.nom}>`}`);
      continue;
    }
    const style = /\sstyle="([^"]*)"/i.exec(attributs ?? '')?.[1] ?? '';
    const ouverte: Balise = { nom: balise, style: declarations(style), aTexte: false };
    balises.push(ouverte);
    if (!VIDES.has(balise)) pile.push(ouverte);
  }
  if (pile.length > 0) throw new Error(`<${pile.map((b) => b.nom).join('><')}> jamais ferme`);
  return { textes, balises };
}

// --- Le contraste (WCAG 2.x) ------------------------------------------------

const HEX = /^#[0-9a-f]{6}$/;

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((debut) => {
    const canal = parseInt(hex.slice(debut, debut + 2), 16) / 255;
    return canal <= 0.03928 ? canal / 12.92 : ((canal + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function ratio(a: string, b: string): number {
  const [clair, sombre] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((clair ?? 0) + 0.05) / ((sombre ?? 0) + 0.05);
}

/** Texte : 4.5, WCAG AA. Barre du graphe, element non textuel : 3 (exception E, le signe n'y est porte que par la teinte). */
export const RATIO_TEXTE = 4.5;
export const RATIO_BARRE = 3;

const hauteur = (balise: Balise): boolean => /^\d+px$/.test(balise.style.get('height') ?? '');

/**
 * Tout ce que le HTML rendu doit au contrat des couleurs, sous forme de defauts :
 * une liste vide est un rendu conforme. Chaque defaut se nomme, pour que le test
 * qui rougit dise ce qui ne va pas sans qu'il faille relire le courrier.
 */
export function defauts(html: string): readonly string[] {
  const trouves: string[] = [];
  for (const interdit of [/<style/i, /\sclass=/i, /<script/i, /<img/i]) {
    if (interdit.test(html)) trouves.push(`balisage interdit : ${String(interdit)}`);
  }

  const { textes, balises } = parcourir(html);

  for (const balise of balises) {
    for (const propriete of ['color', 'background']) {
      const valeur = balise.style.get(propriete);
      if (valeur !== undefined && !HEX.test(valeur)) trouves.push(`<${balise.nom}> ${propriete}:${valeur} n'est pas un #rrggbb`);
    }
    const fond = balise.style.get('background');
    if (fond === undefined) continue;
    if (balise.aTexte) {
      if (!balise.style.has('color')) trouves.push(`<${balise.nom}> pose le fond ${fond} sans poser sa couleur`);
    } else if (balise.nom !== 'div' || !hauteur(balise)) {
      trouves.push(`<${balise.nom}> pose le fond ${fond} sans texte et n'est pas une barre du graphe`);
    } else if (HEX.test(fond) && ratio(fond, FOND_PAR_DEFAUT) < RATIO_BARRE) {
      trouves.push(`barre ${fond} sous ${String(RATIO_BARRE)}:1 sur blanc`);
    }
  }

  for (const { texte, couleur, fond } of textes) {
    if (!HEX.test(couleur) || !HEX.test(fond)) continue;
    const mesure = ratio(couleur, fond);
    if (mesure < RATIO_TEXTE) {
      trouves.push(`« ${texte.slice(0, 40)} » : ${couleur} sur ${fond} fait ${mesure.toFixed(2)}:1, sous ${String(RATIO_TEXTE)}:1`);
    }
  }
  return trouves;
}
