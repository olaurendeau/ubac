import { describe, expect, it } from 'vitest';

import type { HttpOutcome, HttpRequest, HttpSend } from '../../src/adapters/http.js';
import type { PingOutcome, RunPulse } from '../../src/adapters/healthcheck.js';
import { RUN_MARKER, openHealthcheck } from '../../src/adapters/healthcheck.js';

/**
 * Le pulse updown.io de la spec §9. **Aucun reseau** : `openHttp` n'est jamais
 * appele, le transport est une fonction du test, et c'est le corps reellement
 * poste qui est relu.
 *
 * Trois proprietes portent ce fichier, et la troisieme est la raison d'etre du
 * lot.
 *
 * 1. **Le marqueur figure dans le corps si et seulement si le run a abouti.**
 *    Les deux sens sont sondes, et le second l'est jusqu'au cas fautif : un
 *    champ qui porterait la chaine par accident fait ecarter le corps entier.
 * 2. **`ping` ne rejette jamais**, quel que soit le transport et quel que soit
 *    le `RunPulse` qu'on lui donne.
 * 3. **`HEALTHCHECK_URL` ne ressort nulle part.** Ni dans un corps, ni dans un
 *    motif, ni dans ce qu'une exception emporterait. C'est un secret de fait :
 *    qui la connait peut envoyer de faux pings et **masquer un job mort**.
 *
 * La valeur de `RUN_MARKER` n'est recopiee dans aucune sonde : la constante est
 * importee. Deux litteraux divergent, et c'est celui qui n'a pas de sonde qui
 * gagne.
 */

const URL_PULSE = 'https://updown.test/p/jeton-du-pulse-qui-ne-doit-pas-sortir';
const SECRETS = { healthcheckUrl: URL_PULSE };

const GIT_SHA = '15b29e4c0ffee1234567890abcdefabcdefabcde';

function pulse(ending: RunPulse['ending'], overrides: Partial<RunPulse> = {}): RunPulse {
  return { runDate: '2026-09-12', gitSha: GIT_SHA, ending, ...overrides };
}

const CONCLU = pulse({ kind: 'CONCLU', decisions: 4, alerts: 0 });
const ABANDONNE = pulse({ kind: 'ABANDONNE', step: 'RECONCILE', code: 'RECONCILIATION_DRIFT' });
/**
 * Un run conclu dont le compte rendu n'est pas parti. Les deux canaux y sont
 * nommes separement : une alerte perdue et un rapport perdu ne sont pas la meme
 * panne, et le corps doit dire laquelle.
 */
const NON_RENDU = pulse({ kind: 'NON_RENDU', alertsFailed: 2, reportFailed: false });
const RAPPORT_PERDU = pulse({ kind: 'NON_RENDU', alertsFailed: 0, reportFailed: true });
const LES_DEUX_PERDUS = pulse({ kind: 'NON_RENDU', alertsFailed: 2, reportFailed: true });

interface Envoi {
  readonly requetes: HttpRequest[];
  readonly send: HttpSend;
}

/** Un transport qui note ce qu'on lui donne et rend ce qu'on lui a demande. */
function transport(outcome: HttpOutcome = { status: 'OK', httpStatus: 200 }): Envoi {
  const requetes: HttpRequest[] = [];
  return {
    requetes,
    send: (request) => {
      requetes.push(request);
      return Promise.resolve(outcome);
    },
  };
}

/** Le corps d'un ping, une fois parti. Echoue si rien n'est parti. */
async function corpsDe(entree: RunPulse, envoi: Envoi = transport()): Promise<string> {
  await openHealthcheck(SECRETS, envoi.send).ping(entree);
  const requete = envoi.requetes[0];
  if (requete === undefined) throw new Error('aucun ping envoye');
  return requete.body;
}

// --- Le marqueur ------------------------------------------------------------

describe('le marqueur — present si et seulement si le run a abouti', () => {
  it('un run conclu porte le marqueur, et ce qui aide a investiguer', async () => {
    const corps = await corpsDe(CONCLU);

    expect(corps).toContain(RUN_MARKER);
    expect(corps).toContain('run_date=2026-09-12');
    expect(corps).toContain(`git_sha=${GIT_SHA}`);
    expect(corps).toContain('decisions=4');
    expect(corps).toContain('alertes=0');
  });

  /*
   * Les trois autres fins, une par une. Le verdict est le meme — pas de
   * marqueur, donc `DOWN` cote updown.io — mais le corps dit laquelle, et c'est
   * exactement ce que la documentation d'updown promet de conserver pour
   * l'investigation.
   */
  it.each([
    ['un abandon', ABANDONNE, ['RUN_ABANDONNE', 'etape=RECONCILE', 'code=RECONCILIATION_DRIFT']],
    [
      'une alerte manquante',
      NON_RENDU,
      ['RUN_NON_RENDU', 'alertes_non_parties=2', 'rapport_non_parti=non'],
    ],
    /*
     * Le cas que la greffe en deux fois avait failli laisser passer : aucune
     * alerte perdue, et pourtant le run n'a pas rendu compte. Sans lui, un
     * echec d'envoi Brevo pingait avec le marqueur pendant que le code de
     * sortie valait 1 — deux verdicts opposes sur le meme run.
     */
    [
      'un rapport manquant, sans aucune alerte perdue',
      RAPPORT_PERDU,
      ['RUN_NON_RENDU', 'alertes_non_parties=0', 'rapport_non_parti=oui'],
    ],
    [
      'les deux canaux manquants',
      LES_DEUX_PERDUS,
      ['RUN_NON_RENDU', 'alertes_non_parties=2', 'rapport_non_parti=oui'],
    ],
  ])('%s ne porte pas le marqueur et nomme sa cause', async (_cas, entree, attendus) => {
    const corps = await corpsDe(entree);

    expect(corps).not.toContain(RUN_MARKER);
    for (const attendu of attendus) expect(corps).toContain(attendu);
  });

  /*
   * Une fin dont le `kind` n'est aucun des trois. Les types sont effaces a
   * l'execution et `ping` est une interface publique, donc ce cas existe. Le
   * verdict n'est pas « on suppose que c'est un succes » : face a une fin qu'on
   * ne sait pas lire, la surveillance doit sonner.
   */
  /*
   * `reportFailed` est borne comme les autres champs, et pour la meme raison :
   * les types sont effaces, `ping` est une interface publique, et un
   * `String(valeur)` naif ferait sortir dans le corps une chaine venue
   * d'ailleurs — un secret compris. Ce qui n'est ni `true` ni `false` sort en
   * `?`, et jamais en clair.
   */
  it('un rapport_non_parti qui n\'est pas un booleen sort en ?', async () => {
    const pipe = { kind: 'NON_RENDU', alertsFailed: 0, reportFailed: URL_PULSE };
    const corps = await corpsDe(pulse(pipe as unknown as RunPulse['ending']));

    expect(corps).toContain('rapport_non_parti=?');
    expect(corps).not.toContain(URL_PULSE);
    expect(corps).not.toContain(RUN_MARKER);
  });

  it('une fin illisible ne porte pas le marqueur', async () => {
    const inconnue = { kind: 'AUTRE_CHOSE' } as unknown as RunPulse['ending'];
    const corps = await corpsDe(pulse(inconnue));

    expect(corps).not.toContain(RUN_MARKER);
    expect(corps).toContain('RUN_ILLISIBLE');
  });

  /**
   * **La sonde qui compte.** `git_sha` vient de la ligne de commande, donc d'un
   * humain ou d'un script. Un `--git-sha=RUN_CONCLU` ferait sinon lire un
   * abandon comme un succes, et la panne deviendrait invisible exactement le
   * jour ou elle compte — la seule facon de rater une panne *en pingant*.
   *
   * Le corps entier est ecarte, detail de l'abandon compris : un `git_sha`
   * illisible coute une investigation, un faux `UP` coute la panne entiere.
   */
  it('un champ qui porterait le marqueur fait ecarter le corps entier', async () => {
    const corps = await corpsDe(pulse(ABANDONNE.ending, { gitSha: RUN_MARKER }));

    expect(corps).not.toContain(RUN_MARKER);
    expect(corps).toContain('CORPS_REFUSE');
    expect(corps).not.toContain('RECONCILIATION_DRIFT');
  });

  /*
   * L'inverse du cas precedent : un run **conclu** dont un champ porte la chaine
   * garde son marqueur. Le controle ne s'applique qu'aux corps qui ne doivent
   * pas le porter, et l'ecrire dans l'autre sens aurait rendu muet un run sain.
   */
  it('un run conclu garde son marqueur, meme si un champ le repete', async () => {
    const corps = await corpsDe(pulse(CONCLU.ending, { gitSha: RUN_MARKER }));

    expect(corps.startsWith(RUN_MARKER)).toBe(true);
  });
});

// --- Le bornage des champs --------------------------------------------------

/**
 * Meme motif que l'`entier` de `http.ts` : les types sont effaces a
 * l'execution, donc ce qui se presente comme un `git_sha` peut etre n'importe
 * quoi. C'est une **liste de ce qui peut sortir**, jamais une liste de ce qu'il
 * faudrait masquer.
 */
describe('le bornage des champs', () => {
  it.each([
    ['ce qui n’est pas une chaine', 42 as unknown as string, 'git_sha=?'],
    ['ce qui n’a plus rien apres bornage', '///' as string, 'git_sha=?'],
    ['ce qui sort de l’alphabet', 'abc def/../ghi', 'git_sha=abcdefghi'],
  ])('borne %s', async (_cas, gitSha, attendu) => {
    expect(await corpsDe(pulse(CONCLU.ending, { gitSha }))).toContain(attendu);
  });

  it('tronque un champ demesure', async () => {
    const corps = await corpsDe(pulse(CONCLU.ending, { gitSha: 'a'.repeat(4096) }));

    expect(corps).toContain(`git_sha=${'a'.repeat(64)}\n`);
  });

  it.each([
    ['un compte non entier', 1.5, 'decisions=?'],
    ['un compte qui n’est pas un nombre', 'quatre', 'decisions=?'],
    ['un compte entier', 4, 'decisions=4'],
  ])('borne %s', async (_cas, decisions, attendu) => {
    const ending = { kind: 'CONCLU', decisions, alerts: 0 } as unknown as RunPulse['ending'];
    expect(await corpsDe(pulse(ending))).toContain(attendu);
  });
});

// --- Le transport -----------------------------------------------------------

describe('le transport', () => {
  it('poste sur l’URL telle quelle, une fois, et en texte', async () => {
    const envoi = transport();
    await openHealthcheck(SECRETS, envoi.send).ping(CONCLU);

    expect(envoi.requetes).toHaveLength(1);
    expect(envoi.requetes[0]?.url).toBe(URL_PULSE);
    expect(envoi.requetes[0]?.headers).toEqual({ 'Content-Type': 'text/plain; charset=utf-8' });
  });

  it('rend PINGED et ce que le corps disait', async () => {
    const sort = await openHealthcheck(SECRETS, transport().send).ping(CONCLU);

    expect(sort).toEqual<PingOutcome>({ status: 'PINGED', marked: true });
  });

  /*
   * Le motif vient de `motifDe` et de son vocabulaire ferme : ce module ne
   * fabrique aucune chaine d'echec. `marked` reste celui du corps transporte —
   * « le run a abouti mais la surveillance ne l'a pas su » et « le run a
   * abandonne » ne sont pas le meme incident.
   */
  it.each([
    ['un refus', { kind: 'REFUS', httpStatus: 503 }, 'refus du serveur, HTTP 503'],
    ['un delai', { kind: 'DELAI', timeoutMs: 5000 }, 'delai de 5000 ms depasse'],
    ['une panne reseau', { kind: 'RESEAU' }, 'echec reseau'],
  ])('classe %s sans rien recopier', async (_cas, failure, motif) => {
    const envoi = transport({ status: 'FAILED', failure } as HttpOutcome);
    const sort = await openHealthcheck(SECRETS, envoi.send).ping(CONCLU);

    expect(sort).toEqual<PingOutcome>({ status: 'FAILED', marked: true, reason: motif });
  });
});

// --- La garantie : ping ne rejette jamais -----------------------------------

/**
 * C'est cette garantie qui autorise `src/jobs/daily.ts` a pinguer sans `try`.
 * Elle vit **ici**, en un seul endroit : le run est appele apres avoir tout
 * ecrit, et une surveillance injoignable n'a pas a defaire son travail.
 *
 * Chaque sonde verifie deux choses a la fois — que rien ne rejette, et que le
 * jeton de l'URL de pulse ne ressort ni dans le motif ni ailleurs.
 */
describe('ping ne rejette jamais, et ne laisse rien sortir', () => {
  it('un transport qui leve en citant l’URL rend un motif constant', async () => {
    const send: HttpSend = () => {
      throw new Error(`echec vers ${URL_PULSE}`);
    };
    const sort = await openHealthcheck(SECRETS, send).ping(CONCLU);

    expect(sort).toEqual<PingOutcome>({
      status: 'FAILED',
      marked: true,
      reason: 'transport en echec',
    });
  });

  /*
   * Un `RunPulse` dont une propriete est un getter qui leve. Une propriete se
   * lit par un getter, et un getter s'execute : sans le filet, `ping` rejetait
   * en emportant ce que ce getter a jete — et faisait tomber un run qui avait
   * deja tout ecrit. `marked` reste faux : rien n'a pu etre lu, donc rien ne
   * permet d'affirmer que le run a abouti.
   */
  it('un pulse dont la lecture leve ne fait rien rejeter', async () => {
    const envoi = transport();
    const piege = {
      runDate: '2026-09-12',
      get gitSha(): string {
        throw new Error(URL_PULSE);
      },
      ending: CONCLU.ending,
    } as unknown as RunPulse;
    const sort = await openHealthcheck(SECRETS, envoi.send).ping(piege);

    expect(sort).toEqual<PingOutcome>({
      status: 'FAILED',
      marked: false,
      reason: 'transport en echec',
    });
    expect(envoi.requetes).toEqual([]);
  });

  /*
   * Un transport tiers qui rend un `FAILED` sans variante, ou avec une variante
   * inventee. `motifDe` n'accepte que les quatre connues et rend le repli :
   * l'appelant ne choisit pas le texte que nous ecrivons.
   */
  it.each([
    ['sans variante', { status: 'FAILED' }],
    ['avec une variante inventee', { status: 'FAILED', failure: { kind: 'AUTRE' } }],
    ['avec un motif en clair', { status: 'FAILED', reason: URL_PULSE }],
  ])('un sort %s tombe sur le repli', async (_cas, outcome) => {
    const envoi = transport(outcome as HttpOutcome);
    const sort = await openHealthcheck(SECRETS, envoi.send).ping(ABANDONNE);

    expect(sort).toEqual<PingOutcome>({
      status: 'FAILED',
      marked: false,
      reason: 'echec de transport',
    });
  });

  /*
   * Le balayage final : sur les six chemins ci-dessus, la chaine secrete de
   * l'URL ne ressort d'aucun sort. La recherche porte sur la serialisation
   * entiere du sort, pas seulement sur son `reason` — un champ ajoute plus tard
   * tomberait dans la meme sonde.
   */
  it('aucun sort ne porte l’URL du pulse', async () => {
    const leveur: HttpSend = () => {
      throw new Error(URL_PULSE);
    };
    const sorts = await Promise.all([
      openHealthcheck(SECRETS, transport().send).ping(CONCLU),
      openHealthcheck(SECRETS, transport().send).ping(ABANDONNE),
      openHealthcheck(SECRETS, leveur).ping(NON_RENDU),
      openHealthcheck(SECRETS, transport({ status: 'FAILED', failure: { kind: 'RESEAU' } }).send).ping(
        CONCLU,
      ),
    ]);

    expect(JSON.stringify(sorts)).not.toContain('jeton-du-pulse');
  });

  /*
   * Et le corps non plus. Le pulse part chez un tiers qui le conserve et
   * l'affiche : y faire figurer l'URL reviendrait a publier la cle de sa propre
   * surveillance.
   */
  it('aucun corps ne porte l’URL du pulse', async () => {
    const corps = await Promise.all([corpsDe(CONCLU), corpsDe(ABANDONNE), corpsDe(NON_RENDU)]);

    expect(corps.join('\n')).not.toContain('jeton-du-pulse');
  });
});

// --- La construction --------------------------------------------------------

/**
 * Le seul point de ce module hors filet, et c'est assume : une URL invalide doit
 * echouer bruyamment au cablage, pas au premier ping, quand il est trop tard
 * pour le dire. `loadConfig` l'a de toute facon deja validee en `https://`.
 */
describe('la construction', () => {
  it('normalise l’URL sans rien lui concatener', async () => {
    const envoi = transport();
    await openHealthcheck({ healthcheckUrl: 'https://updown.test/p/jeton' }, envoi.send).ping(
      CONCLU,
    );

    expect(envoi.requetes[0]?.url).toBe('https://updown.test/p/jeton');
  });

  it('refuse une URL illisible au cablage, pas au premier ping', () => {
    expect(() => openHealthcheck({ healthcheckUrl: 'pas-une-url' }, transport().send)).toThrow();
  });
});
