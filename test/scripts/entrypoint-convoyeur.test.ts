import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

/**
 * Le point d'entree de l'image du convoyeur (lot Y6), execute tel quel par
 * `sh`, avec un `node` simule en tete du `PATH` qui recopie ses arguments : ce
 * que le script passe, et a qui, sans image ni Docker. `verifier-image.sh`
 * refait le constat dans l'image construite.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = resolve(ROOT, 'scripts/entrypoint-convoyeur.sh');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const lancer = promisify(execFile);

const SIMULES = mkdtempSync(join(tmpdir(), 'ubac-entree-'));
writeFileSync(join(SIMULES, 'node'), '#!/bin/sh\nfor arg in "$@"; do echo "node> $arg"; done\n');
chmodSync(join(SIMULES, 'node'), 0o755);

interface Sortie {
  readonly code: number;
  readonly journal: readonly string[];
  readonly node: readonly string[];
  readonly stderr: string;
}

async function entrer(args: readonly string[], env: Record<string, string>): Promise<Sortie> {
  const environnement = { PATH: `${SIMULES}:${process.env.PATH ?? ''}`, ...env };
  const lire = (stdout: string, stderr: string, code: number): Sortie => {
    const lignes = stdout.split('\n').filter((l) => l !== '');
    return {
      code,
      journal: lignes.filter((l) => !l.startsWith('node> ')),
      node: lignes.filter((l) => l.startsWith('node> ')).map((l) => l.slice('node> '.length)),
      stderr,
    };
  };
  try {
    const { stdout, stderr } = await lancer('sh', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8', env: environnement });
    return lire(stdout, stderr, 0);
  } catch (erreur) {
    const echec = erreur as { code?: number; stdout?: string; stderr?: string };
    return lire(echec.stdout ?? '', echec.stderr ?? '', echec.code ?? -1);
  }
}

describe('le point d’entree de l’image du convoyeur', () => {
  it('lance dist/convoyeur/main.js, et lui seul, avec --at et --git-sha', async () => {
    const sortie = await entrer([], { UBAC_GIT_SHA: SHA });
    expect(sortie.code).toBe(0);
    const [main, at, sha, ...reste] = sortie.node;
    // CV3 : jamais daily-main.js, que l'image du convoyeur n'embarque pas.
    expect(main).toBe('dist/convoyeur/main.js');
    expect(at).toMatch(/^--at=/);
    expect(at?.slice('--at='.length)).toMatch(INSTANT);
    expect(sha).toBe(`--git-sha=${SHA}`);
    // Sans argument du declencheur, aucun --reel : le passage est un DRY_RUN.
    expect(reste).toEqual([]);
  });

  it('journalise l’instant meme qu’il passe, et le SHA', async () => {
    const sortie = await entrer([], { UBAC_GIT_SHA: SHA });
    expect(sortie.journal).toEqual([`convoyeur: ${sortie.node[1]?.slice(2) ?? ''} git_sha=${SHA}`]);
  });

  it('ajoute les arguments du declencheur apres les siens : --reel, et rien d’autre', async () => {
    const sortie = await entrer(['--reel'], { UBAC_GIT_SHA: SHA });
    expect(sortie.node.slice(3)).toEqual(['--reel']);
  });

  it('refuse une image construite sans SHA, avant de lancer node', async () => {
    const sortie = await entrer(['--reel'], {});
    expect(sortie.code).not.toBe(0);
    expect(sortie.stderr).toContain('UBAC_GIT_SHA');
    expect(sortie.node).toEqual([]);
  });
});
