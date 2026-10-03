import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { load } from 'js-yaml';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Les deux etapes des jobs `deploy` et `deploy-convoyeur` qui decident (lot R3
 * de la phase 2, Y7b) : les controles, avant la mise a jour, et la relecture,
 * apres. Deux scripts du depot (`scripts/deploiement/`, extraits en Y7a),
 * executes tels que `.github/workflows/ci.yml` les appelle — son `run`, avec son
 * `env` et donc les valeurs de chaque job qu'il epingle —, avec le bash et le jq
 * du poste.
 *
 * `workflow.test.ts` prouve qu'elles sont la et a leur place ; ce fichier prouve
 * qu'elles mordent. Les lectures Scaleway sont fabriquees a la forme que rend
 * `scw … -o json` (scaleway-sdk-go, `api/jobs/v1alpha2`) : une definition, un
 * tableau de declencheurs, une reponse `{ secrets }`. L'horloge est un `date`
 * de substitution, pour tenir les deux cotes du changement d'heure.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFINITION = 'de0f0000-0000-4000-8000-000000000001';
const PRECEDENTE = `rg.fr-par.scw.cloud/ubac/ubac:${'a'.repeat(40)}`;
const NOUVELLE = `rg.fr-par.scw.cloud/ubac/ubac:${'b'.repeat(40)}`;
const LOIN_DU_RUN = '2026-09-28T12:00:00Z';

/** Les sept variables ordinaires : en clair dans la definition, jamais dans le journal. */
const ORDINAIRES: Readonly<Record<string, string>> = {
  BREVO_RECIPIENT: 'destinataire@exemple.invalid',
  BREVO_SENDER: 'ubac@exemple.invalid',
  COINBASE_PORTFOLIO_UUID: '0b9d7c1e-5f3a-4c2b-9e8d-7a6f5e4d3c2b',
  HEALTHCHECK_URL: 'https://pulse.exemple.invalid/jeton-du-pulse',
  NTFY_TOKEN: 'CANAL-PUBLIC-SANS-JETON',
  NTFY_TOPIC: 'topic-de-l-operateur',
  NTFY_URL: 'https://ntfy.exemple.invalid',
};
const SECRETES = ['BREVO_API_KEY', 'COINBASE_API_KEY', 'COINBASE_API_SECRET', 'DATABASE_URL'];

type Json = Record<string, unknown>;

interface Etat {
  readonly definition: Json;
  readonly declencheurs: unknown;
  readonly secrets: unknown;
}

function declencheur(schedule: string, timezone: string, name = 'daily'): Json {
  return {
    id: 'd0c10000-0000-4000-8000-000000000002',
    job_definition_id: DEFINITION,
    name,
    created_at: '2026-09-15T18:00:00Z',
    updated_at: '2026-09-15T18:00:00Z',
    cron_config: { schedule, timezone, startup_command: [], args: [] },
  };
}

/** La production telle que constatee le 2026-09-27. */
function production(): Etat {
  return {
    definition: {
      id: DEFINITION,
      name: 'ubac-daily',
      project_id: '0b0e0000-0000-4000-8000-000000000003',
      created_at: '2026-09-15T18:00:00Z',
      updated_at: '2026-09-26T19:00:00Z',
      cpu_limit: 140,
      memory_limit: 256,
      local_storage_capacity: 1000,
      image_uri: PRECEDENTE,
      environment_variables: { ...ORDINAIRES },
      job_timeout: '300.000000000s',
      description: '',
      cron_schedule: null,
      startup_command: [],
      args: [],
      retry_policy: { max_retries: 0 },
      region: 'fr-par',
    },
    declencheurs: [declencheur('0 7 * * *', 'Europe/Paris')],
    secrets: {
      secrets: SECRETES.map((nom, i) => ({
        secret_id: `5ec0000${i}-0000-4000-8000-000000000000`,
        secret_manager_id: `5ec1000${i}-0000-4000-8000-000000000000`,
        secret_manager_version: '1',
        job_definition_id: DEFINITION,
        env_var: { name: nom },
      })),
      total_count: SECRETES.length,
    },
  };
}

/** La meme production, repointee sur la nouvelle image : ce qu'une mise a jour correcte laisse. */
function deployee(): Etat {
  const etat = production();
  return { ...etat, definition: { ...etat.definition, image_uri: NOUVELLE, updated_at: '2026-09-27T20:00:00Z' } };
}

function avecDefinition(etat: Etat, changements: Json): Etat {
  return { ...etat, definition: { ...etat.definition, ...changements } };
}

function sansVariable(etat: Etat, nom: string): Etat {
  const variables = Object.entries(etat.definition['environment_variables'] as Json);
  return avecDefinition(etat, { environment_variables: Object.fromEntries(variables.filter(([k]) => k !== nom)) });
}

function sansSecret(etat: Etat, nom: string): Etat {
  const liste = (etat.secrets as { secrets: { env_var: { name: string } }[] }).secrets;
  const secrets = liste.filter((s) => s.env_var.name !== nom);
  return { ...etat, secrets: { secrets, total_count: secrets.length } };
}

// --- L'execution d'une etape, telle que le runner la lance -------------------------

const DOSSIER = mkdtempSync(join(tmpdir(), 'ubac-deploy-'));
afterAll(() => rmSync(DOSSIER, { recursive: true, force: true }));
let executions = 0;

type Job = 'deploy' | 'deploy-convoyeur';

/** L'image que chaque job deploie : celle que `build` lui donne en sortie. */
const REFERENCES: Readonly<Record<Job, string>> = {
  deploy: NOUVELLE,
  'deploy-convoyeur': `rg.fr-par.scw.cloud/ubac/ubac-convoyeur:${'b'.repeat(40)}`,
};

function etape(id: string, job: Job): { readonly run: string; readonly env: Json } {
  const workflow = load(readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8')) as Json;
  const deploy = (workflow['jobs'] as Json)[job] as Json | undefined;
  const trouvee = ((deploy?.['steps'] ?? []) as Json[]).find((s) => s['id'] === id);
  if (typeof trouvee?.['run'] !== 'string') throw new Error(`${job} : aucune etape « ${id} »`);
  return { run: trouvee['run'], env: (trouvee['env'] ?? {}) as Json };
}

interface Issue {
  readonly code: number | null;
  readonly sortie: string;
  readonly erreurs: string;
  readonly resume: string;
}

function executer(id: string, avant: Etat, apres: Etat | undefined, maintenant = LOIN_DU_RUN, job: Job = 'deploy'): Issue {
  const temp = join(DOSSIER, String(executions++));
  mkdirSync(join(temp, 'bin'), { recursive: true });
  // Le seul `date` que l'etape voit : l'instant du test, dans le fuseau qu'elle demande.
  writeFileSync(join(temp, 'bin/date'), '#!/bin/sh\nexec /usr/bin/date -d "@$FAUX_MAINTENANT" "$@"\n');
  chmodSync(join(temp, 'bin/date'), 0o755);
  for (const [moment, etat] of [['avant', avant], ['apres', apres]] as const) {
    if (etat === undefined) continue;
    writeFileSync(join(temp, `${moment}-definition.json`), JSON.stringify(etat.definition));
    writeFileSync(join(temp, `${moment}-declencheurs.json`), JSON.stringify(etat.declencheurs));
    writeFileSync(join(temp, `${moment}-secrets.json`), JSON.stringify(etat.secrets));
  }
  const resume = join(temp, 'resume.md');
  writeFileSync(resume, '');
  const { run, env } = etape(id, job);
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', run], {
    encoding: 'utf8',
    cwd: ROOT,
    env: {
      ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])),
      PATH: `${join(temp, 'bin')}:${process.env['PATH'] ?? ''}`,
      RUNNER_TEMP: temp,
      GITHUB_STEP_SUMMARY: resume,
      DEFINITION,
      REFERENCE: REFERENCES[job],
      FAUX_MAINTENANT: String(Date.parse(maintenant) / 1000),
    },
  });
  if (r.error !== undefined) throw r.error;
  if (/jq: (?:command )?not found/.test(r.stderr)) throw new Error('jq absent de l image du poste : make build');
  const issue = { code: r.status, sortie: r.stdout, erreurs: r.stderr, resume: readFileSync(resume, 'utf8') };
  // Le journal est public : aucune valeur ordinaire, hors des ::add-mask:: qu'Actions consomme.
  const journal = `${issue.sortie}\n${issue.erreurs}\n${issue.resume}`
    .split('\n')
    .filter((l) => !l.startsWith('::add-mask::'))
    .join('\n');
  for (const valeur of Object.values(ORDINAIRES)) expect(journal).not.toContain(valeur);
  return issue;
}

// --- Les controles avant -----------------------------------------------------------

describe('controles avant : la production est dans l etat attendu, et le run est loin', () => {
  it('la production telle qu elle tourne passe, et le tag precedent est ecrit', () => {
    const issue = executer('controles', production(), undefined);
    expect(issue.code).toBe(0);
    const retour = `scw jobs definition update ${DEFINITION} image-uri=${PRECEDENTE} region=fr-par`;
    expect(issue.sortie).toContain(`image deployee jusqu'ici : ${PRECEDENTE}`);
    expect(issue.sortie).toContain(`retour en arriere : ${retour}`);
    expect(issue.resume).toContain(retour);
  });

  it('chaque variable ordinaire est masquee avant toute autre ligne', () => {
    const masques = executer('controles', production(), undefined).sortie.split('\n').slice(0, 7);
    expect(masques.sort()).toEqual(Object.values(ORDINAIRES).map((v) => `::add-mask::${v}`).sort());
  });

  it.each([
    ['un cpu remis aux 100 de la documentation', avecDefinition(production(), { cpu_limit: 100 }), 'cpu-limit 100, attendu 140'],
    ['une memoire doublee', avecDefinition(production(), { memory_limit: 512 }), 'memory-limit 512, attendu 256'],
    ['un delai de 301 s', avecDefinition(production(), { job_timeout: '301.000000000s' }), 'job-timeout 301.000000000s'],
    ['une tentative', avecDefinition(production(), { retry_policy: { max_retries: 1 } }), 'max-retries 1, attendu 0'],
    ['une politique de tentatives absente', avecDefinition(production(), { retry_policy: null }), 'max-retries null'],
    [
      'un cron pose sur la definition',
      avecDefinition(production(), { cron_schedule: { schedule: '0 7 * * *', timezone: 'UTC' } }),
      'un cron sur la definition',
    ],
    ['une variable ordinaire absente', sansVariable(production(), 'BREVO_SENDER'), 'variable BREVO_SENDER absente'],
    ['un secret absent', sansSecret(production(), 'DATABASE_URL'), 'variable DATABASE_URL absente'],
    ['aucun declencheur', { ...production(), declencheurs: [] }, 'declencheurs [], attendu le seul « daily »'],
    [
      'un second declencheur',
      { ...production(), declencheurs: [declencheur('0 7 * * *', 'Europe/Paris'), declencheur('0 8 * * *', 'UTC', 'essai')] },
      'declencheurs ["daily","essai"]',
    ],
    ['un declencheur renomme', { ...production(), declencheurs: [declencheur('0 7 * * *', 'Europe/Paris', 'matin')] }, '["matin"]'],
    [
      'une variable du convoyeur sur la definition d Ubac (CV3)',
      avecDefinition(production(), { environment_variables: { ...ORDINAIRES, CONVOYEUR_NTFY_URL: 'https://ntfy.exemple.invalid' } }),
      'variable CONVOYEUR_NTFY_URL interdite',
    ],
  ])('%s : refus, rien n est modifie', (_, avant, motif) => {
    const issue = executer('controles', avant, undefined);
    expect(issue.code).toBe(1);
    expect(issue.erreurs).toContain("REFUS, rien n'a ete modifie");
    expect(issue.erreurs).toContain(motif);
    expect(issue.sortie).toContain(`image deployee jusqu'ici : ${PRECEDENTE}`);
  });

  // Le run est a 07:00 heure de Paris : 05:00 UTC en ete, 06:00 UTC apres le 25 octobre 2026.
  it.each([
    ['en ete, 06:50 a Paris (04:50 UTC) : refus', '2026-09-28T04:50:00Z', 'Europe/Paris', 1],
    ['en ete, 07:15 a Paris : refus', '2026-09-28T05:15:00Z', 'Europe/Paris', 1],
    ['en ete, 07:16 a Paris : deploiement', '2026-09-28T05:16:00Z', 'Europe/Paris', 0],
    ['en hiver, 06:50 a Paris (05:50 UTC) : refus', '2026-10-26T05:50:00Z', 'Europe/Paris', 1],
    ['en hiver, 04:50 UTC, refuse en ete, n est que 05:50 a Paris : deploiement', '2026-10-26T04:50:00Z', 'Europe/Paris', 0],
    ['un run en UTC, lu sans le decalage de Paris : refus', '2026-09-28T06:55:00Z', 'UTC', 1],
  ])('%s', (_, maintenant, fuseau, code) => {
    const avant = { ...production(), declencheurs: [declencheur('0 7 * * *', fuseau)] };
    const issue = executer('controles', avant, undefined, maintenant);
    expect(issue.code).toBe(code);
    expect(issue.erreurs).toContain(code === 1 ? 'min du run' : '');
  });

  it('la fenetre enjambe minuit', () => {
    const avant = { ...production(), declencheurs: [declencheur('5 0 * * *', 'Europe/Paris')] };
    expect(executer('controles', avant, undefined, '2026-09-28T21:55:00Z').erreurs).toContain('a 10 min du run');
  });

  it.each([
    ['un horaire qui n est pas quotidien', '0 7 * * 1-5', 'Europe/Paris'],
    ['un fuseau inconnu, que date prendrait pour UTC', '0 7 * * *', 'Europe/Atlantide'],
    ['un fuseau vide', '0 7 * * *', ''],
  ])('%s : refus, forme non lue', (_, schedule, fuseau) => {
    const issue = executer('controles', { ...production(), declencheurs: [declencheur(schedule, fuseau)] }, undefined);
    expect([issue.code, issue.erreurs]).toEqual([1, expect.stringContaining('forme non lue')]);
  });
});

// --- La relecture ------------------------------------------------------------------

describe('relecture : la nouvelle image, et tout le reste tel qu il etait', () => {
  it('une mise a jour de la seule image passe, et le journal dit ce qu il a relu', () => {
    const issue = executer('relecture', production(), deployee());
    expect(issue.code).toBe(0);
    const relu = `relu : ${NOUVELLE}, cpu 140, memoire 256, delai 300.000000000s, tentatives 0, variables ${Object.keys(ORDINAIRES).join(' ')}`;
    expect(issue.sortie).toContain(relu);
    expect(issue.resume).toContain(relu);
  });

  const secretsSans = sansSecret(deployee(), 'DATABASE_URL').secrets;
  it.each([
    ['l image n a pas change', production(), `image-uri relue « ${PRECEDENTE} », attendu « ${NOUVELLE} »`],
    ['la table des variables remplacee par une table vide', avecDefinition(deployee(), { environment_variables: {} }), 'variable NTFY_TOPIC'],
    [
      'une variable reecrite',
      avecDefinition(deployee(), { environment_variables: { ...ORDINAIRES, HEALTHCHECK_URL: 'https://autre.invalid' } }),
      'variable HEALTHCHECK_URL : ajoute, retire ou change',
    ],
    ['un delai change', avecDefinition(deployee(), { job_timeout: '600.000000000s' }), 'reglage job_timeout'],
    ['un cpu change', avecDefinition(deployee(), { cpu_limit: 100 }), 'reglage cpu_limit'],
    ['des tentatives ajoutees', avecDefinition(deployee(), { retry_policy: { max_retries: 3 } }), 'reglage retry_policy'],
    ['un cron ajoute a la definition', avecDefinition(deployee(), { cron_schedule: { schedule: '0 7 * * *', timezone: 'UTC' } }), 'reglage cron_schedule'],
    ['le declencheur efface', { ...deployee(), declencheurs: [] }, 'declencheur daily'],
    ['le declencheur deplace', { ...deployee(), declencheurs: [declencheur('0 9 * * *', 'Europe/Paris')] }, 'declencheur daily'],
    ['un secret detache', { ...deployee(), secrets: secretsSans }, 'secret DATABASE_URL'],
  ])('%s : la relecture rougit', (_, apres, motif) => {
    const issue = executer('relecture', production(), apres);
    expect(issue.code).toBe(1);
    expect(issue.erreurs).toContain('RELECTURE EN ECHEC');
    expect(issue.erreurs).toContain(motif);
  });
});

// --- Le convoyeur (lot Y7b) ----------------------------------------------------------

const DEFINITION_CONVOYEUR = 'de0f0000-0000-4000-8000-00000000000c';
const PRECEDENTE_CONVOYEUR = `rg.fr-par.scw.cloud/ubac/ubac-convoyeur:${'a'.repeat(40)}`;
const SECRETES_CONVOYEUR = [
  'CONVOYEUR_DATABASE_URL',
  'CONVOYEUR_COINBASE_API_KEY',
  'CONVOYEUR_COINBASE_API_SECRET',
  'CONVOYEUR_PRIMARY_UUID',
  'CONVOYEUR_DESTINATION_UUID',
  'CONVOYEUR_NTFY_URL',
  'CONVOYEUR_NTFY_TOPIC',
  'CONVOYEUR_NTFY_TOKEN',
];

function declencheurConvoyeur(args: unknown, schedule = '0 19 * * *'): Json {
  const d = declencheur(schedule, 'Europe/Paris', 'convoyeur');
  return { ...d, job_definition_id: DEFINITION_CONVOYEUR, cron_config: { ...(d['cron_config'] as Json), args } };
}

/** La definition qu'OP4 cree (docs/convoyeur.md) : huit secrets, aucune variable ordinaire, et le mode donne. */
function convoyeur(args: unknown = null): Etat {
  const ubac = production();
  return {
    definition: {
      ...ubac.definition,
      id: DEFINITION_CONVOYEUR,
      name: 'ubac-convoyeur',
      image_uri: PRECEDENTE_CONVOYEUR,
      environment_variables: {},
      job_timeout: '600.000000000s',
    },
    declencheurs: [declencheurConvoyeur(args)],
    secrets: {
      secrets: SECRETES_CONVOYEUR.map((nom, i) => ({
        secret_id: `5ec0000${i}-0000-4000-8000-00000000000c`,
        secret_manager_id: `5ec1000${i}-0000-4000-8000-00000000000c`,
        secret_manager_version: '1',
        job_definition_id: DEFINITION_CONVOYEUR,
        env_var: { name: nom },
      })),
      total_count: SECRETES_CONVOYEUR.length,
    },
  };
}

function convoyeurDeploye(args: unknown = null): Etat {
  const etat = convoyeur(args);
  return {
    ...etat,
    definition: { ...etat.definition, image_uri: REFERENCES['deploy-convoyeur'], updated_at: '2026-09-27T20:00:00Z' },
  };
}

function controlesConvoyeur(avant: Etat, maintenant = LOIN_DU_RUN): Issue {
  return executer('controles', avant, undefined, maintenant, 'deploy-convoyeur');
}

function relectureConvoyeur(avant: Etat, apres: Etat): Issue {
  return executer('relecture', avant, apres, LOIN_DU_RUN, 'deploy-convoyeur');
}

describe('controles avant du convoyeur : ses valeurs, sa fenetre, et le mode dit sans jamais refuser', () => {
  it.each([
    ['sans argument (null, ce que rend le SDK)', null, 'DRY_RUN'],
    ['avec un tableau vide', [], 'DRY_RUN'],
    ['avec --reel', ['--reel'], 'REEL'],
    ['avec --reel parmi d autres', ['--verbeux', '--reel'], 'REEL'],
    ['avec --real, que main.ts refuse : ni reel ni refus ici', ['--real'], 'DRY_RUN'],
  ])('la definition d OP4 %s passe, et le mode est dit : %s', (_, args, mode) => {
    const issue = controlesConvoyeur(convoyeur(args));
    expect(issue.code).toBe(0);
    expect(issue.sortie).toContain(`mode du convoyeur : ${mode}`);
    expect(issue.resume).toContain(`### Mode du convoyeur\n\n${mode}\n`);
    expect(issue.resume).toContain(`image-uri=${PRECEDENTE_CONVOYEUR}`);
  });

  it.each([
    ['une variable d Ubac en clair', avecDefinition(convoyeur(), { environment_variables: { NTFY_URL: 'https://ntfy.exemple.invalid' } }), 'variable NTFY_URL interdite'],
    ['un secret d Ubac', { ...convoyeur(), secrets: production().secrets }, 'variable DATABASE_URL interdite'],
    ['un reglage d Ubac', avecDefinition(convoyeur(), { environment_variables: { UBAC_STRATEGY: 'x' } }), 'variable UBAC_STRATEGY interdite'],
    ['une variable du convoyeur absente', sansSecret(convoyeur(), 'CONVOYEUR_PRIMARY_UUID'), 'variable CONVOYEUR_PRIMARY_UUID absente'],
    ['le delai d Ubac', avecDefinition(convoyeur(), { job_timeout: '300.000000000s' }), 'job-timeout 300.000000000s, attendu 600s'],
    ['une tentative', avecDefinition(convoyeur(), { retry_policy: { max_retries: 1 } }), 'max-retries 1, attendu 0'],
    ['le declencheur d Ubac', { ...convoyeur(), declencheurs: [declencheur('0 7 * * *', 'Europe/Paris')] }, 'attendu le seul « convoyeur »'],
    ['la definition d Ubac elle-meme', production(), 'attendu le seul « convoyeur »'],
  ])('%s : refus, rien n est modifie', (_, avant, motif) => {
    const issue = controlesConvoyeur(avant);
    expect(issue.code).toBe(1);
    expect(issue.erreurs).toContain("REFUS, rien n'a ete modifie");
    expect(issue.erreurs).toContain(motif);
  });

  it('un refus dit le mode quand meme', () => {
    const issue = controlesConvoyeur(avecDefinition(convoyeur(['--reel']), { cpu_limit: 100 }));
    expect([issue.code, issue.sortie]).toEqual([1, expect.stringContaining('mode du convoyeur : REEL')]);
  });

  it.each([
    ['des arguments en chaine', '--reel'],
    ['des arguments qui ne sont pas des chaines', { reel: true }],
  ])('%s : refus, forme non lue, plutot qu un DRY_RUN mal dit', (_, args) => {
    const issue = controlesConvoyeur(convoyeur(args));
    expect([issue.code, issue.erreurs]).toEqual([1, expect.stringContaining('arguments du declencheur « convoyeur », forme non lue')]);
    expect(issue.sortie).not.toContain('mode du convoyeur');
  });

  it('un declencheur sans cle args : refus, forme non lue', () => {
    const d = declencheurConvoyeur(null);
    const { args: _, ...sansArgs } = d['cron_config'] as Json;
    const issue = controlesConvoyeur({ ...convoyeur(), declencheurs: [{ ...d, cron_config: sansArgs }] });
    expect([issue.code, issue.erreurs]).toEqual([1, expect.stringContaining('forme non lue')]);
  });

  // Le passage est a 19:00 a Paris, 17:00 UTC en ete. Ubac, a 07:00, est loin.
  it.each([
    ['18:50 a Paris : refus du convoyeur', '2026-09-28T16:50:00Z', 1],
    ['19:15 a Paris : refus du convoyeur', '2026-09-28T17:15:00Z', 1],
    ['19:16 a Paris : deploiement', '2026-09-28T17:16:00Z', 0],
    ['06:55 a Paris, la fenetre d Ubac : le convoyeur se deploie', '2026-09-28T04:55:00Z', 0],
  ])('%s', (_, maintenant, code) => {
    expect(controlesConvoyeur(convoyeur(), maintenant).code).toBe(code);
  });

  it('un tag a 18:50 deploie Ubac et refuse le convoyeur', () => {
    const maintenant = '2026-09-28T16:50:00Z';
    expect(executer('controles', production(), undefined, maintenant).code).toBe(0);
    expect(controlesConvoyeur(convoyeur(), maintenant).erreurs).toContain('a 10 min du run « 0 19 * * * »');
  });
});

describe('relecture du convoyeur : sa nouvelle image, et le mode inchange', () => {
  it.each([
    [null, 'DRY_RUN'],
    [['--reel'], 'REEL'],
  ])('arguments %j : la relecture passe et dit le mode %s', (args, mode) => {
    const issue = relectureConvoyeur(convoyeur(args), convoyeurDeploye(args));
    expect(issue.code).toBe(0);
    expect(issue.sortie).toContain(`relu : ${REFERENCES['deploy-convoyeur']}, cpu 140, memoire 256, delai 600.000000000s, tentatives 0, variables \n`);
    expect(issue.resume).toContain(`mode du convoyeur relu, inchange : ${mode}`);
  });

  it.each([
    ['passe en reel pendant le deploiement', null, ['--reel'], 'mode du convoyeur DRY_RUN avant, REEL apres'],
    ['revenu au DRY_RUN pendant le deploiement', ['--reel'], [], 'mode du convoyeur REEL avant, DRY_RUN apres'],
  ])('%s : la relecture rougit', (_, avant, apres, motif) => {
    const issue = relectureConvoyeur(convoyeur(avant), convoyeurDeploye(apres));
    expect(issue.code).toBe(1);
    expect(issue.erreurs).toContain('RELECTURE EN ECHEC');
    expect(issue.erreurs).toContain(motif);
    expect(issue.erreurs).toContain('declencheur convoyeur');
  });

  it('l image d Ubac posee sur la definition du convoyeur : la relecture rougit', () => {
    const apres = avecDefinition(convoyeurDeploye(), { image_uri: NOUVELLE });
    expect(relectureConvoyeur(convoyeur(), apres).erreurs).toContain(`attendu « ${REFERENCES['deploy-convoyeur']} »`);
  });
});
