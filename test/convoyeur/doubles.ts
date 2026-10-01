import type {
  Apport,
  ConvoyeurBase,
  Ecriture,
  EtapeAEcrire,
  LigneApport,
  LigneJournal,
} from '../../src/convoyeur/base.js';
import { dernierDepuisLignes, ligneApport, ligneJournal } from '../../src/convoyeur/base.js';

/**
 * La base du convoyeur en memoire, pour le passage (Y4b). Elle passe par les
 * memes fonctions de ligne que la vraie, et tient les memes refus que ses
 * index : une etape par convoyage, un `ACHAT_DEMANDE` par jour, un apport par
 * clef naturelle. `test/convoyeur/base.test.ts` eprouve les deux par le meme
 * contrat.
 */
export interface DoubleBase extends ConvoyeurBase {
  readonly journal: readonly LigneJournal[];
  readonly apports: readonly LigneApport[];
}

export function doubleBase(): DoubleBase {
  const journal: LigneJournal[] = [];
  const apports: LigneApport[] = [];

  return {
    journal,
    apports,

    dernierConvoyage() {
      const jours = journal.map((l) => l.day).sort();
      const dernier = jours.at(-1);
      return Promise.resolve(dernierDepuisLignes(journal.filter((l) => l.day === dernier)));
    },

    ecrireEtape(etape: EtapeAEcrire): Promise<Ecriture> {
      const ligne = ligneJournal(etape);
      const deja = journal.some(
        (l) =>
          (l.convoyage === ligne.convoyage && l.step === ligne.step) ||
          (ligne.step === 'ACHAT_DEMANDE' && l.step === 'ACHAT_DEMANDE' && l.day === ligne.day),
      );
      if (deja) return Promise.resolve('ALREADY_RECORDED');
      journal.push(ligne);
      return Promise.resolve('RECORDED');
    },

    ecrireApport(apport: Apport): Promise<Ecriture> {
      const ligne = ligneApport(apport);
      if (apports.some((l) => l.naturalKey === ligne.naturalKey)) return Promise.resolve('ALREADY_RECORDED');
      apports.push(ligne);
      return Promise.resolve('RECORDED');
    },
  };
}
