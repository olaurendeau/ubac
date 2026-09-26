import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

import config from '../../vitest.config.js';

/**
 * Le garde-fou des workflows (lot R1 de la phase 2, spec §10).
 *
 * Un workflow sans test est un fichier dont personne ne peut montrer qu'il mord :
 * retirer `needs: test` ne rougit nulle part, sauf dans une chaine qu'on ne lit
 * qu'apres coup. Ce fichier ramene ces affirmations dans la suite du poste.
 *
 * Il lit **ce que les fichiers disent**, pas ce que GitHub execute. La
 * protection de `main` (D3) est un geste de console qu'aucune ligne d'ici ne
 * voit : `docs/integration-continue.md` dit ce qui doit y etre coche.
 *
 * Forme : chaque regle rend la liste de ses violations sur un depot. Le depot
 * reel n'en a aucune (les affirmations) ; chaque sonde mute un fichier du depot
 * reel et constate que la regle visee rougit (les variantes). Une sonde dont la
 * mutation ne trouve plus son ancre echoue elle aussi : une variante perimee ne
 * doit pas passer pour une regle qui mord.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = '.github/workflows';
const PORTE = `${WORKFLOWS}/ci.yml`;

/** Le nom du controle requis (D3). Un contrat, pas un choix de style. */
const JOB_PORTE = 'test';

/** Le job qui construit, verifie et pousse l'image (lot R2). */
const JOB_IMAGE = 'build';

/**
 * La seule condition admise sur `build` (D4 = 2) : une poussee, jamais une PR,
 * dont le commit de fusion disparait au merge avec l'image qui le porterait.
 */
const SI_POUSSEE = "github.event_name == 'push'";

/** Ce que `build` execute, dans cet ordre : les deux scripts du depot, puis la poussee. */
const ETAPES_IMAGE = ['./scripts/build-image.sh', './scripts/verifier-image.sh', 'docker push'];

/** Seule l'absence constatee dans le registre ouvre la construction : rien ne s'ecrase. */
const SI_ABSENTE = "steps.registre.outputs.existe == 'non'";

/** Ce que le job ne refait pas : construire autrement, ou recopier les controles des scripts. */
const SECONDE_DEFINITION = /docker\s+(?:buildx\s+)?build\b|--push\b|docker\s+(?:image\s+)?inspect\b|docker\s+tag\b|UBAC_GIT_SHA/;

/**
 * Ce que la porte execute, dans l'ordre. La couverture et non `npm test` : elle
 * rejoue toute la suite et fait respecter les 100 % de `src/core/risk.ts`.
 */
const COMMANDES_PORTE = ['npm ci', 'npm run typecheck', 'npm run test:coverage'];
const SCRIPT_COUVERTURE = 'vitest run --coverage';
const SEUIL_RISQUE = { lines: 100, branches: 100, functions: 100, statements: 100 };

/** Ou vit la version de Node du poste et de la production. */
const NODE_DES_DOCKERFILES = [
  { fichier: 'Dockerfile', motif: /^FROM\s+node:(\d+)\b/m },
  { fichier: 'Dockerfile.prod', motif: /^ARG\s+NODE_IMAGE=node:(\d+)\b/m },
];

/** Ce qu'aucune ligne d'un workflow ne prononce, commentaires compris. */
const MIGRATION = /drizzle-kit|db-push|db:push/i;
const LATEST = /latest/i;

/** Une cle qui nomme un identifiant n'a qu'une valeur admise : un secret. */
const CLE_SECRETE = /secret|password|passwd|token|api[_-]?key|access[_-]?key|private[_-]?key/i;
const VALEUR_SECRETE = /^\$\{\{\s*secrets\.[A-Za-z_][A-Za-z0-9_]*\s*\}\}$/;

// --- Le depot, tel que les regles le lisent -----------------------------------

/** Les fichiers par chemin relatif, et les seuils de couverture de vitest.config.ts. */
interface Depot {
  readonly fichiers: ReadonlyMap<string, string>;
  readonly seuils: unknown;
}

function depotReel(): Depot {
  const chemins = [
    ...readdirSync(resolve(ROOT, WORKFLOWS))
      .filter((nom) => /\.ya?ml$/.test(nom))
      .map((nom) => `${WORKFLOWS}/${nom}`),
    'package.json',
    ...NODE_DES_DOCKERFILES.map((d) => d.fichier),
  ];
  return {
    fichiers: new Map(chemins.map((c) => [c, readFileSync(resolve(ROOT, c), 'utf8')])),
    seuils: config.test?.coverage?.thresholds,
  };
}

type Objet = Readonly<Record<string, unknown>>;

function estObjet(valeur: unknown): valeur is Objet {
  return typeof valeur === 'object' && valeur !== null && !Array.isArray(valeur);
}

function objet(valeur: unknown, ou: string): Objet {
  if (!estObjet(valeur)) throw new Error(`${ou} : un objet est attendu`);
  return valeur;
}

function texte(depot: Depot, chemin: string): string {
  const contenu = depot.fichiers.get(chemin);
  if (contenu === undefined) throw new Error(`${chemin} : fichier absent`);
  return contenu;
}

function workflows(depot: Depot): readonly (readonly [string, string])[] {
  return [...depot.fichiers].filter(([chemin]) => chemin.startsWith(`${WORKFLOWS}/`));
}

function porte(depot: Depot): Objet {
  return objet(load(texte(depot, PORTE)), PORTE);
}

function jobs(workflow: Objet, ou: string): Objet {
  return objet(workflow['jobs'], `${ou} > jobs`);
}

function jobPorte(depot: Depot): Objet | undefined {
  const job = jobs(porte(depot), PORTE)[JOB_PORTE];
  return estObjet(job) ? job : undefined;
}

function jobImage(depot: Depot): Objet | undefined {
  const job = jobs(porte(depot), PORTE)[JOB_IMAGE];
  return estObjet(job) ? job : undefined;
}

function steps(job: Objet): readonly Objet[] {
  const liste = job['steps'];
  return Array.isArray(liste) ? liste.filter(estObjet) : [];
}

function besoins(job: unknown): readonly string[] {
  const needs = estObjet(job) ? job['needs'] : undefined;
  if (typeof needs === 'string') return [needs];
  return Array.isArray(needs) ? needs.filter((n): n is string => typeof n === 'string') : [];
}

/** Les commandes des `run:` d'un job, une par ligne et par enchainement. */
function commandes(job: Objet): readonly string[] {
  return steps(job)
    .map((step) => step['run'])
    .filter((run): run is string => typeof run === 'string')
    .flatMap((run) => run.split(/\n|&&|\|\||;/))
    .map((ligne) => ligne.trim())
    .filter((ligne) => ligne !== '' && !ligne.startsWith('#'));
}

function manifeste(depot: Depot): Objet {
  return objet(JSON.parse(texte(depot, 'package.json')), 'package.json');
}

/** Les lignes d'un workflow qui prononcent un motif interdit, avec leur adresse. */
function lignes(depot: Depot, motif: RegExp): readonly string[] {
  return workflows(depot).flatMap(([chemin, contenu]) =>
    contenu
      .split('\n')
      .flatMap((ligne, i) => (motif.test(ligne) ? [`${chemin}:${i + 1} « ${ligne.trim()} »`] : [])),
  );
}

// --- Versions de Node : juste ce que le garde-fou a besoin de comparer ---------

type Version = readonly [number, number, number];

function comparer(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * Le plus petit et le plus grand Node qu'une version de workflow designe :
 * `22` va de 22.0.0 au dernier 22.x. Les comparateurs d'un intervalle etant
 * monotones, si les deux bornes le satisfont, tout ce qui est entre elles aussi.
 */
function bornes(version: string): readonly [Version, Version] | undefined {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(version);
  if (m === null) return undefined;
  const haut = Number.MAX_SAFE_INTEGER;
  const [maj, min, pat] = [Number(m[1]), m[2], m[3]];
  return [
    [maj, Number(min ?? 0), Number(pat ?? 0)],
    [maj, min === undefined ? haut : Number(min), pat === undefined ? haut : Number(pat)],
  ];
}

/**
 * `engines.node` lu comme une conjonction de `>=X[.Y[.Z]]` et `<X[.Y[.Z]]`, les
 * seules formes ou completer par des zeros est exact. Toute autre forme rend un
 * motif, pas un faux vert : qui change `engines` etend ce garde-fou.
 */
function horsIntervalle(version: Version, intervalle: string): string | undefined {
  for (const comparateur of intervalle.trim().split(/\s+/)) {
    const m = /^(>=|<)v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(comparateur);
    if (m === null) return `forme « ${intervalle} » non lue par ce garde-fou, a etendre`;
    const ecart = comparer(version, [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)]);
    if (m[1] === '>=' ? ecart < 0 : ecart >= 0) return `hors de « ${intervalle} »`;
  }
  return undefined;
}

// --- Les regles -----------------------------------------------------------------

interface Regle {
  readonly nom: string;
  readonly verifier: (depot: Depot) => readonly string[];
}

const REGLES = {
  nom: {
    nom: 'le controle requis s appelle test, et rien ne le renomme',
    verifier: (depot) => {
      const job = jobPorte(depot);
      if (job === undefined) return [`aucun job « ${JOB_PORTE} » : le controle requis disparait`];
      const nom = job['name'];
      return nom === undefined || nom === JOB_PORTE
        ? []
        : [`job ${JOB_PORTE} renomme « ${String(nom)} » : la protection de main ne le voit plus`];
    },
  },
  commandes: {
    nom: 'la porte execute la couverture, et la suite une seule fois',
    verifier: (depot) => {
      const vues = commandes(jobPorte(depot) ?? {});
      return isDeepStrictEqual(vues, COMMANDES_PORTE)
        ? []
        : [`commandes ${JSON.stringify(vues)}, attendu ${JSON.stringify(COMMANDES_PORTE)}`];
    },
  },
  couverture: {
    nom: 'la couverture fait respecter les 100 % de src/core/risk.ts',
    verifier: (depot) => {
      const motifs: string[] = [];
      const script = objet(manifeste(depot)['scripts'], 'scripts')['test:coverage'];
      if (script !== SCRIPT_COUVERTURE) {
        motifs.push(`script test:coverage « ${String(script)} », attendu « ${SCRIPT_COUVERTURE} »`);
      }
      const seuil = estObjet(depot.seuils) ? depot.seuils['src/core/risk.ts'] : undefined;
      if (!isDeepStrictEqual(seuil, SEUIL_RISQUE)) {
        motifs.push(`seuil de src/core/risk.ts ${JSON.stringify(seuil)}, attendu 100 partout`);
      }
      return motifs;
    },
  },
  scripts: {
    nom: 'toute commande npm d un workflow est npm ci ou un script de package.json',
    verifier: (depot) => {
      const declares = objet(manifeste(depot)['scripts'], 'scripts');
      const motifs: string[] = [];
      for (const [chemin, contenu] of workflows(depot)) {
        for (const [nomJob, job] of Object.entries(jobs(objet(load(contenu), chemin), chemin))) {
          for (const commande of commandes(objet(job, `${chemin} > ${nomJob}`))) {
            const ou = `${chemin} > ${nomJob} : « ${commande} »`;
            if (/^npx\b/.test(commande)) motifs.push(`${ou} contourne package.json`);
            const npm = /^npm\s+(\S+)(?:\s+(\S+))?/.exec(commande);
            if (npm === null || npm[1] === 'ci') continue;
            const script = ['test', 't'].includes(npm[1] ?? '') ? 'test' : npm[1] === 'run' ? npm[2] : undefined;
            if (script === undefined) motifs.push(`${ou} : seuls npm ci et npm run <script> sont admis`);
            else if (!(script in declares)) motifs.push(`${ou} : aucun script « ${script} » dans package.json`);
          }
        }
      }
      return motifs;
    },
  },
  node: {
    nom: 'la porte tourne sur le Node de package.json, du poste et de la production',
    verifier: (depot) => {
      const setup = steps(jobPorte(depot) ?? {}).find((s) =>
        String(s['uses']).startsWith('actions/setup-node@'),
      );
      const avec = setup?.['with'];
      const version = String((estObjet(avec) ? avec['node-version'] : undefined) ?? '');
      const extremes = bornes(version);
      if (extremes === undefined) return [`node-version « ${version} » : un majeur epingle est attendu`];
      const engines = manifeste(depot)['engines'];
      const intervalle = String((estObjet(engines) ? engines['node'] : undefined) ?? '');
      const motifs = [
        ...new Set(extremes.map((v) => horsIntervalle(v, intervalle))),
      ].flatMap((r) => (r === undefined ? [] : [`node-version « ${version} » : engines.node ${r}`]));
      for (const { fichier, motif } of NODE_DES_DOCKERFILES) {
        const majeur = motif.exec(texte(depot, fichier))?.[1];
        if (majeur === undefined) motifs.push(`${fichier} : version de Node introuvable`);
        else if (Number(majeur) !== extremes[0][0]) {
          motifs.push(`node-version « ${version} » : ${fichier} tourne sur Node ${majeur}`);
        }
      }
      return motifs;
    },
  },
  needs: {
    nom: 'build attend test, deploy attend build, et tout job passe par test',
    verifier: (depot) => {
      const tous = jobs(porte(depot), PORTE);
      const motifs: string[] = [];
      for (const [job, besoin] of [['build', JOB_PORTE], ['deploy', 'build']] as const) {
        if (job in tous && !besoins(tous[job]).includes(besoin)) {
          motifs.push(`job ${job} sans « needs: ${besoin} »`);
        }
      }
      // Un job renomme echappe aux deux lignes ci-dessus, pas a celle-ci.
      const passeParPorte = (job: string, vus: ReadonlySet<string>): boolean =>
        job === JOB_PORTE ||
        (!vus.has(job) && besoins(tous[job]).some((b) => passeParPorte(b, new Set([...vus, job]))));
      for (const job of Object.keys(tous)) {
        if (!passeParPorte(job, new Set())) motifs.push(`job ${job} ne depend pas de ${JOB_PORTE}`);
      }
      return motifs;
    },
  },
  inconditionnelle: {
    nom: 'la porte ne se saute pas et n avale aucun echec',
    verifier: (depot) => {
      const job = jobPorte(depot) ?? {};
      const blocs = [
        [`job ${JOB_PORTE}`, job] as const,
        ...steps(job).map((s, i) => [`step ${i + 1}`, s] as const),
      ];
      return blocs.flatMap(([ou, bloc]) => {
        const avale = bloc['continue-on-error'];
        return [
          // Un controle requis saute compte comme reussi : un `if` ouvre la porte en silence.
          ...('if' in bloc ? [`${ou} : un if saute la porte, et un controle saute compte comme vert`] : []),
          ...(avale === undefined || avale === false ? [] : [`${ou} : continue-on-error avale l'echec`]),
        ];
      });
    },
  },
  latest: {
    nom: 'aucune ligne d un workflow ne dit latest',
    verifier: (depot) => lignes(depot, LATEST),
  },
  migration: {
    nom: 'aucune ligne d un workflow ne migre',
    verifier: (depot) => lignes(depot, MIGRATION),
  },
  secrets: {
    nom: 'un identifiant n arrive que par secrets., et la porte n en voit aucun',
    verifier: (depot) => {
      const motifs: string[] = [];
      const parcourir = (valeur: unknown, ou: string): void => {
        if (Array.isArray(valeur)) valeur.forEach((v, i) => parcourir(v, `${ou}[${i}]`));
        if (!estObjet(valeur)) return;
        for (const [cle, v] of Object.entries(valeur)) {
          const scalaire = typeof v === 'string' || typeof v === 'number';
          if (CLE_SECRETE.test(cle) && scalaire && !VALEUR_SECRETE.test(String(v))) {
            motifs.push(`${ou} > ${cle} : un identifiant n'arrive que par \${{ secrets.NOM }}`);
          }
          parcourir(v, `${ou} > ${cle}`);
        }
      };
      for (const [chemin, contenu] of workflows(depot)) parcourir(load(contenu), chemin);
      if (JSON.stringify(jobPorte(depot) ?? {}).includes('secrets.')) {
        motifs.push(`job ${JOB_PORTE} : il fait tourner toutes les dependances, il ne voit aucun secret`);
      }
      return motifs;
    },
  },
  declencheurs: {
    nom: 'la chaine se declenche sur main, les tags v* et les PR vers main, et rien d autre',
    verifier: (depot) => {
      const attendu = { push: { branches: ['main'], tags: ['v*'] }, pull_request: { branches: ['main'] } };
      const vus = porte(depot)['on'];
      return isDeepStrictEqual(vus, attendu)
        ? []
        : [`declencheurs ${JSON.stringify(vus)}, attendu ${JSON.stringify(attendu)}`];
    },
  },
  jeton: {
    nom: 'le jeton de chaque job ne fait que lire le code',
    verifier: (depot) =>
      Object.entries(jobs(porte(depot), PORTE)).flatMap(([nom, job]) => {
        const effectives = (estObjet(job) ? job['permissions'] : undefined) ?? porte(depot)['permissions'];
        return isDeepStrictEqual(effectives, { contents: 'read' })
          ? []
          : [`job ${nom} : permissions ${JSON.stringify(effectives)}, attendu {"contents":"read"}`];
      }),
  },
  image: {
    nom: 'build construit et verifie par les scripts du depot avant de pousser, et rien d autre',
    verifier: (depot) => {
      const job = jobImage(depot);
      if (job === undefined) return [`aucun job « ${JOB_IMAGE} » : l'image ne sort plus de la chaine`];
      const vues = commandes(job);
      const rangs = ETAPES_IMAGE.map((etape) => vues.findIndex((c) => c.startsWith(etape)));
      const motifs = ETAPES_IMAGE.flatMap((etape, i) =>
        rangs[i] === -1 ? [`job ${JOB_IMAGE} : aucune etape « ${etape} »`] : [],
      );
      if (motifs.length === 0 && !rangs.every((r, i) => i === 0 || r > (rangs[i - 1] ?? -1))) {
        motifs.push(`job ${JOB_IMAGE} : ordre ${JSON.stringify(vues)}, attendu ${ETAPES_IMAGE.join(' puis ')}`);
      }
      for (const commande of vues.filter((c) => SECONDE_DEFINITION.test(c))) {
        motifs.push(`job ${JOB_IMAGE} : « ${commande} » double ce que font les scripts du depot`);
      }
      return motifs;
    },
  },
  fusion: {
    nom: 'build ne construit jamais une PR, dont le commit de fusion disparait',
    verifier: (depot) => {
      const si = jobImage(depot)?.['if'];
      return si === SI_POUSSEE
        ? []
        : [`job ${JOB_IMAGE} : if ${JSON.stringify(si)}, attendu « ${SI_POUSSEE} » : une PR serait construite`];
    },
  },
  reecriture: {
    nom: 'une image deja poussee n est jamais reconstruite ni reecrite',
    verifier: (depot) => {
      const job = jobImage(depot) ?? {};
      const motifs: string[] = [];
      const registre = steps(job).find((s) => s['id'] === 'registre');
      const sonde = String(registre?.['run'] ?? '');
      if (!sonde.includes('imagetools inspect "$UBAC_REFERENCE"') || !sonde.includes(': not found')) {
        motifs.push('aucune etape « registre » qui constate l absence de la reference');
      }
      for (const step of steps(job)) {
        const run = String(step['run'] ?? '');
        if (ETAPES_IMAGE.some((e) => run.includes(e)) && step['if'] !== SI_ABSENTE) {
          motifs.push(`« ${run} » sans « if: ${SI_ABSENTE} » : elle ecraserait l'image deja poussee`);
        }
      }
      // main et un tag v* sur le meme commit : sans file par SHA, deux executions
      // constateraient l'absence en meme temps.
      const file = job['concurrency'];
      const annule = estObjet(file) ? file['cancel-in-progress'] : undefined;
      if (!estObjet(file) || !String(file['group']).includes('github.sha') || (annule !== false && annule !== 'false')) {
        motifs.push(`job ${JOB_IMAGE} : concurrency ${JSON.stringify(file)}, attendu une file par github.sha, sans annulation`);
      }
      return motifs;
    },
  },
  connexion: {
    nom: 'la cle secrete n entre que par l entree standard du seul docker login',
    verifier: (depot) => {
      const motifs = lignes(depot, /set\s+-\S*x|xtrace/).map((l) => `${l} : une trace recopie les secrets`);
      const parcourir = (valeur: unknown, ou: readonly string[], step: Objet | undefined): void => {
        if (typeof valeur === 'string' && valeur.includes('secrets.')) {
          const run = String(step?.['run'] ?? '');
          const dansEnvDeStep = ou.length >= 2 && ou[ou.length - 2] === 'env' && step !== undefined;
          const parStdin =
            /^printf '%s' "\$\w+" \| docker login "\$REGISTRE" --username nologin --password-stdin$/.test(run.trim());
          if (!dansEnvDeStep || !parStdin) {
            motifs.push(`${ou.join(' > ')} : un secret ne vit que dans l'env d'un docker login --password-stdin`);
          }
        }
        if (Array.isArray(valeur)) valeur.forEach((v, i) => parcourir(v, [...ou, String(i)], step));
        if (!estObjet(valeur)) return;
        const estStep = ou[ou.length - 2] === 'steps';
        for (const [cle, v] of Object.entries(valeur)) parcourir(v, [...ou, cle], estStep ? valeur : step);
      };
      for (const [chemin, contenu] of workflows(depot)) parcourir(load(contenu), [chemin], undefined);
      return motifs;
    },
  },
  rafale: {
    nom: 'une rafale de poussees annule les PR, jamais main',
    verifier: (depot) => {
      const concurrence = porte(depot)['concurrency'];
      if (!estObjet(concurrence)) return ['aucun concurrency au niveau du workflow'];
      const motifs: string[] = [];
      if (!String(concurrence['group']).includes('github.ref')) motifs.push('groupe sans github.ref');
      const annule = concurrence['cancel-in-progress'];
      if (annule === true || annule === 'true') motifs.push('cancel-in-progress vrai : main serait interrompu');
      return motifs;
    },
  },
} satisfies Record<string, Regle>;

// --- Les sondes -----------------------------------------------------------------

function avecFichier(depot: Depot, chemin: string, contenu: string): Depot {
  return { ...depot, fichiers: new Map([...depot.fichiers, [chemin, contenu]]) };
}

function muter(depot: Depot, chemin: string, avant: string, apres: string): Depot {
  const contenu = texte(depot, chemin);
  // Une ancre perdue ferait passer une variante perimee pour une regle qui mord.
  if (!contenu.includes(avant)) throw new Error(`${chemin} : ancre « ${avant} » introuvable`);
  return avecFichier(depot, chemin, contenu.replace(avant, () => apres));
}

/** `jobs` est la derniere cle du workflow : un job s'ajoute en fin de fichier. */
function ajouterJobs(depot: Depot, yaml: string): Depot {
  return avecFichier(depot, PORTE, `${texte(depot, PORTE)}${yaml}`);
}

/** Une ligne de plus dans le job `test`, juste apres son delai. */
function dansLaPorte(depot: Depot, yaml: string): Depot {
  return muter(depot, PORTE, '    timeout-minutes: 15\n', `    timeout-minutes: 15\n${yaml}\n`);
}

/**
 * La chaine complete du §10, telle que R2 et R3 la livreront. Un job que le
 * workflow reel porte deja n'est pas rajoute : a partir de R2, les sondes de
 * `needs` mordent sur le vrai `build`, pas sur une copie.
 */
const CHAINE = {
  build: `
  build:
    needs: test
    runs-on: ubuntu-24.04
    steps:
      - run: ./scripts/build-image.sh
`,
  deploy: `
  deploy:
    needs: build
    runs-on: ubuntu-24.04
    environment: production
    steps:
      - run: ./scripts/verifier-image.sh
`,
};

function avecChaine(depot: Depot): Depot {
  const presents = jobs(porte(depot), PORTE);
  const manquants = Object.entries(CHAINE).filter(([job]) => !(job in presents));
  return ajouterJobs(depot, manquants.map(([, yaml]) => yaml).join(''));
}

interface Sonde {
  readonly regle: keyof typeof REGLES;
  readonly mutation: string;
  readonly appliquer: (depot: Depot) => Depot;
  readonly motif: string;
}

const NODE_22 = "node-version: '22'";
const POUSSER = '        run: docker push "$UBAC_REFERENCE"\n';
const VERIFIER = `      - if: ${SI_ABSENTE}\n        run: ./scripts/verifier-image.sh "$UBAC_REFERENCE"\n`;
const CONNEXION = `printf '%s' "$SCW_SECRET_KEY" | docker login "$REGISTRE" --username nologin --password-stdin`;
const COUVRIR = '- run: npm run test:coverage';
const INSTALLER = '- run: npm ci\n';

const SONDES: readonly Sonde[] = [
  {
    regle: 'needs',
    mutation: 'retirer needs: test du job build',
    appliquer: (d) => muter(avecChaine(d), PORTE, '    needs: test\n', ''),
    motif: 'job build sans « needs: test »',
  },
  {
    regle: 'needs',
    mutation: 'retirer needs: build du job deploy',
    appliquer: (d) => muter(avecChaine(d), PORTE, '    needs: build\n', ''),
    motif: 'job deploy sans « needs: build »',
  },
  {
    regle: 'needs',
    mutation: 'un job build renomme, qui ne passe plus par test',
    appliquer: (d) => muter(avecChaine(d), PORTE, '  build:\n    needs: test\n', '  image:\n'),
    motif: 'job image ne depend pas de test',
  },
  {
    regle: 'commandes',
    mutation: 'remplacer la couverture par npm test',
    appliquer: (d) => muter(d, PORTE, COUVRIR, '- run: npm test'),
    motif: '"npm test"]',
  },
  {
    regle: 'commandes',
    mutation: 'payer la suite deux fois',
    appliquer: (d) => muter(d, PORTE, COUVRIR, `- run: npm test\n      ${COUVRIR}`),
    motif: '"npm test","npm run test:coverage"]',
  },
  {
    regle: 'couverture',
    mutation: 'un script de couverture sans --coverage',
    appliquer: (d) => muter(d, 'package.json', `"test:coverage": "${SCRIPT_COUVERTURE}"`, '"test:coverage": "vitest run"'),
    motif: 'script test:coverage « vitest run »',
  },
  {
    regle: 'couverture',
    mutation: 'un seuil de branches a 99 % sur risk.ts',
    appliquer: (d) => ({ ...d, seuils: { 'src/core/risk.ts': { ...SEUIL_RISQUE, branches: 99 } } }),
    motif: 'seuil de src/core/risk.ts',
  },
  {
    regle: 'scripts',
    mutation: 'un script absent de package.json',
    appliquer: (d) => ajouterJobs(d, '  lint:\n    needs: test\n    steps:\n      - run: npm run lint\n'),
    motif: 'aucun script « lint »',
  },
  {
    regle: 'scripts',
    mutation: 'npx a la place d un script',
    appliquer: (d) => ajouterJobs(d, '  outil:\n    needs: test\n    steps:\n      - run: npx tsc\n'),
    motif: '« npx tsc » contourne package.json',
  },
  {
    regle: 'migration',
    mutation: 'ecrire drizzle-kit dans un workflow',
    appliquer: (d) => muter(d, PORTE, INSTALLER, `${INSTALLER}      - run: npx drizzle-kit push\n`),
    motif: '« - run: npx drizzle-kit push »',
  },
  {
    regle: 'migration',
    mutation: 'le script db:push',
    appliquer: (d) => muter(d, PORTE, INSTALLER, `${INSTALLER}      - run: npm run db:push\n`),
    motif: '« - run: npm run db:push »',
  },
  {
    regle: 'migration',
    mutation: 'la cible db-push, dans un commentaire d un second workflow',
    appliquer: (d) => avecFichier(d, `${WORKFLOWS}/migre.yml`, 'jobs: {}\n# make db-push\n'),
    motif: 'migre.yml:2',
  },
  {
    regle: 'inconditionnelle',
    mutation: 'un if sur le job test',
    appliquer: (d) => dansLaPorte(d, "    if: github.event_name == 'push'"),
    motif: 'job test : un if saute la porte',
  },
  {
    regle: 'inconditionnelle',
    mutation: 'une couverture dont l echec est avale',
    appliquer: (d) => muter(d, PORTE, COUVRIR, `${COUVRIR}\n        continue-on-error: true`),
    motif: 'continue-on-error avale',
  },
  {
    regle: 'latest',
    mutation: 'un runner latest',
    appliquer: (d) => muter(d, PORTE, 'runs-on: ubuntu-24.04', 'runs-on: ubuntu-latest'),
    motif: '« runs-on: ubuntu-latest »',
  },
  {
    regle: 'node',
    mutation: 'un Node que package.json refuse',
    appliquer: (d) => muter(d, PORTE, NODE_22, "node-version: '20'"),
    motif: 'engines.node hors de « >=22 »',
  },
  {
    regle: 'node',
    mutation: 'un Node que ni le poste ni la production ne font tourner',
    appliquer: (d) => muter(d, PORTE, NODE_22, "node-version: '24'"),
    motif: 'Dockerfile tourne sur Node 22',
  },
  {
    regle: 'node',
    mutation: 'un engines releve sans toucher au workflow',
    appliquer: (d) => muter(d, 'package.json', '"node": ">=22"', '"node": ">=22.99"'),
    motif: 'engines.node hors de « >=22.99 »',
  },
  {
    regle: 'node',
    mutation: 'une version de Node non epinglee',
    appliquer: (d) => muter(d, PORTE, NODE_22, "node-version: 'lts/*'"),
    motif: 'un majeur epingle est attendu',
  },
  {
    regle: 'nom',
    mutation: 'renommer le job test',
    appliquer: (d) => muter(d, PORTE, '  test:\n', '  tests:\n'),
    motif: 'aucun job « test »',
  },
  {
    regle: 'nom',
    mutation: 'donner au job test un autre nom affiche',
    appliquer: (d) => dansLaPorte(d, '    name: Tests'),
    motif: 'renomme « Tests »',
  },
  {
    regle: 'jeton',
    mutation: 'un jeton qui ecrit',
    appliquer: (d) => muter(d, PORTE, '  contents: read\n', '  contents: write\n'),
    motif: '{"contents":"write"}',
  },
  {
    regle: 'secrets',
    mutation: 'une cle secrete en clair',
    appliquer: (d) => dansLaPorte(d, '    env:\n      SCW_SECRET_KEY: en-clair'),
    motif: 'env > SCW_SECRET_KEY',
  },
  {
    regle: 'secrets',
    mutation: 'un secret confie a la porte',
    appliquer: (d) => dansLaPorte(d, '    env:\n      SCW_SECRET_KEY: ${{ secrets.SCW_SECRET_KEY }}'),
    motif: 'il ne voit aucun secret',
  },
  {
    regle: 'declencheurs',
    mutation: 'retirer le declencheur pull_request',
    appliquer: (d) => muter(d, PORTE, '  pull_request:\n    branches: [main]\n', ''),
    motif: 'declencheurs {"push"',
  },
  {
    regle: 'declencheurs',
    mutation: 'ajouter pull_request_target',
    appliquer: (d) => muter(d, PORTE, '  pull_request:\n', '  pull_request_target:\n  pull_request:\n'),
    motif: '"pull_request_target":null',
  },
  {
    regle: 'fusion',
    mutation: 'ajouter pull_request aux declencheurs du job build',
    appliquer: (d) =>
      muter(d, PORTE, `    if: ${SI_POUSSEE}\n`, `    if: ${SI_POUSSEE} || github.event_name == 'pull_request'\n`),
    motif: 'une PR serait construite',
  },
  {
    regle: 'fusion',
    mutation: 'retirer la condition du job build',
    appliquer: (d) => muter(d, PORTE, `    if: ${SI_POUSSEE}\n`, ''),
    motif: 'if undefined',
  },
  {
    regle: 'declencheurs',
    mutation: 'retirer les tags v*',
    appliquer: (d) => muter(d, PORTE, "    tags: ['v*']\n", ''),
    motif: 'declencheurs {"push":{"branches":["main"]}',
  },
  {
    regle: 'image',
    mutation: 'retirer l appel a verifier-image.sh',
    appliquer: (d) => muter(d, PORTE, VERIFIER, ''),
    motif: 'aucune etape « ./scripts/verifier-image.sh »',
  },
  {
    regle: 'image',
    mutation: 'pousser avant de verifier',
    appliquer: (d) => muter(muter(d, PORTE, VERIFIER, ''), PORTE, POUSSER, `${POUSSER}${VERIFIER}`),
    motif: 'attendu ./scripts/build-image.sh puis',
  },
  {
    regle: 'image',
    mutation: 'construire et pousser d un seul buildx, sans les scripts',
    appliquer: (d) =>
      muter(d, PORTE, 'run: ./scripts/build-image.sh "$UBAC_IMAGE"', 'run: docker buildx build --push -t "$UBAC_REFERENCE" .'),
    motif: 'double ce que font les scripts du depot',
  },
  {
    regle: 'image',
    mutation: 'recopier le controle d architecture dans le YAML',
    appliquer: (d) =>
      muter(d, PORTE, POUSSER, `${POUSSER}      - run: docker image inspect --format '{{.Architecture}}' "$UBAC_REFERENCE"\n`),
    motif: '« docker image inspect',
  },
  {
    regle: 'latest',
    mutation: 'ecrire latest dans un tag',
    appliquer: (d) =>
      muter(d, PORTE, POUSSER, `${POUSSER}      - run: docker tag "$UBAC_REFERENCE" "$UBAC_IMAGE:latest"\n`),
    motif: 'UBAC_IMAGE:latest',
  },
  {
    regle: 'reecriture',
    mutation: 'pousser sans constater l absence',
    appliquer: (d) => muter(d, PORTE, `      - if: ${SI_ABSENTE}\n${POUSSER}`, `      - ${POUSSER.trimStart()}`),
    motif: 'elle ecraserait l\'image deja poussee',
  },
  {
    regle: 'reecriture',
    mutation: 'traiter toute erreur du registre comme une absence',
    appliquer: (d) => muter(d, PORTE, 'elif [[ "$sortie" == *": not found" ]]; then', 'else'),
    motif: 'constate l absence',
  },
  {
    regle: 'reecriture',
    mutation: 'annuler une construction en cours sur le meme SHA',
    appliquer: (d) => muter(d, PORTE, '      cancel-in-progress: false\n', '      cancel-in-progress: true\n'),
    motif: 'une file par github.sha',
  },
  {
    regle: 'connexion',
    mutation: 'la cle secrete en argument de docker login',
    appliquer: (d) =>
      muter(d, PORTE, CONNEXION, 'docker login "$REGISTRE" --username nologin --password "$SCW_SECRET_KEY"'),
    motif: 'env > SCW_SECRET_KEY',
  },
  {
    regle: 'connexion',
    mutation: 'le secret interpole dans le script',
    appliquer: (d) => muter(d, PORTE, `"$SCW_SECRET_KEY" | docker login`, '"${{ secrets.SCW_SECRET_KEY }}" | docker login'),
    motif: 'run : un secret',
  },
  {
    regle: 'connexion',
    mutation: 'le secret expose a tout le job build',
    appliquer: (d) =>
      muter(d, PORTE, '      REGISTRE: rg.fr-par.scw.cloud\n', '      REGISTRE: rg.fr-par.scw.cloud\n      CLE: ${{ secrets.SCW_SECRET_KEY }}\n'),
    motif: 'build > env > CLE',
  },
  {
    regle: 'connexion',
    mutation: 'une trace set -x dans le job build',
    appliquer: (d) => muter(d, PORTE, `run: ${CONNEXION}`, `run: set -x; ${CONNEXION}`),
    motif: 'une trace recopie les secrets',
  },
  {
    regle: 'jeton',
    mutation: 'un job build dont le jeton ecrit',
    appliquer: (d) => muter(d, PORTE, '    permissions:\n      contents: read\n', '    permissions:\n      contents: write\n'),
    motif: 'job build : permissions {"contents":"write"}',
  },
  {
    regle: 'rafale',
    mutation: 'annuler aussi les executions de main',
    appliquer: (d) =>
      muter(d, PORTE, "cancel-in-progress: ${{ github.event_name == 'pull_request' }}", 'cancel-in-progress: true'),
    motif: 'main serait interrompu',
  },
];

// --- Les tests --------------------------------------------------------------------

describe('la porte du depot, telle que les workflows la disent', () => {
  const reel = depotReel();

  it.each(Object.values(REGLES).map((r) => [r.nom, r] as const))('%s', (_, regle) => {
    expect(regle.verifier(reel)).toEqual([]);
  });

  it('la chaine test -> build -> deploy du §10 passe toutes les regles', () => {
    expect(Object.values(REGLES).flatMap((r) => r.verifier(avecChaine(reel)))).toEqual([]);
  });
});

describe('chaque regle mord : une mutation du depot reel la fait rougir', () => {
  const reel = depotReel();

  it.each(SONDES.map((s) => [s.mutation, s] as const))('%s', (_, sonde) => {
    const regle = REGLES[sonde.regle];
    expect(regle.verifier(sonde.appliquer(reel))).toContainEqual(expect.stringContaining(sonde.motif));
  });

  it('aucune regle sans sonde', () => {
    expect(new Set(SONDES.map((s) => s.regle))).toEqual(new Set(Object.keys(REGLES)));
  });
});
