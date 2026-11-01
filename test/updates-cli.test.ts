import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('outdated --json keeps the array on stdout, reports what it could not check on stderr, and exits 1', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'atlas-updates-cli-'));
  const home = join(cwd, 'home');
  const skills = join(home, '.agents', 'skills');
  for (const name of ['x', 'y']) {
    mkdirSync(join(skills, name), { recursive: true });
    writeFileSync(join(skills, name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
  writeFileSync(join(home, '.agents', '.skill-lock.json'), JSON.stringify({ version: 3, skills: {
    x: { source: 'o/r', sourceType: 'github', skillPath: 'skills/x/SKILL.md', skillFolderHash: 'old' },
    y: { source: 'down/repo', sourceType: 'github', skillPath: 'skills/y/SKILL.md', skillFolderHash: 'old' },
  } }));
  const preload = join(cwd, 'fetch.mjs');
  writeFileSync(preload, `globalThis.fetch = async (url) => String(url).includes('/repos/o/r/')
    ? Response.json({ sha: 'root', tree: [{ path: 'skills/x', type: 'tree', sha: 'new' }] })
    : new Response('rate limited', { status: 403 });`);
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', tsx, '--import', pathToFileURL(preload).href, fileURLToPath(new URL('../src/cli.tsx', import.meta.url)), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, SKILLS_ATLAS_LANG: 'en', SKILLS_ATLAS_OFFLINE: '1', XDG_CONFIG_HOME: join(cwd, 'config'), HOME: home, USERPROFILE: home, GITHUB_TOKEN: 'secret-token' },
  });
  try {
    const json = run('outdated', '--json');
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout).map((s: { id: string }) => s.id)).toEqual(['o/r@x']);
    expect(json.stderr).toContain('Update check incomplete');
    expect(json.stderr).toContain('down/repo: HTTP 403');
    expect(json.stderr).not.toContain('secret-token');
    const update = run('update', '--dry-run', '-y', '--no-audit', '--symlink');
    expect(update.status).toBe(1);
    expect(update.stdout).toContain('add o/r -s x');
    expect(update.stdout).not.toContain('up to date');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 60_000);

it('finds and updates an outdated project skill in the project, and suggests skills for the project', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'atlas-project-cli-'));
  const home = join(cwd, 'home');
  mkdirSync(home);
  const dir = join(cwd, '.agents', 'skills', 'p');
  mkdirSync(dir, { recursive: true });
  const markdown = '---\nname: p\n---\nv1\n';
  writeFileSync(join(dir, 'SKILL.md'), markdown);
  const hash = createHash('sha256').update('SKILL.md').update(markdown).digest('hex');
  writeFileSync(join(cwd, 'skills-lock.json'), JSON.stringify({ version: 1, skills: { p: { source: 'o/r', sourceType: 'github', skillPath: 'skills/p/SKILL.md', computedHash: hash } } }));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }));
  const preload = join(cwd, 'fetch.mjs');
  // HEAD has a new SKILL.md: its blob SHA differs from the installed file's.
  // Only GitHub is faked: the terminal's layout engine loads its WebAssembly through fetch too.
  writeFileSync(preload, `const real = globalThis.fetch;
globalThis.fetch = async (url, init) => String(url).startsWith('https://api.github.com/')
  ? Response.json({ sha: 'root', tree: [{ path: 'skills/p/SKILL.md', type: 'blob', sha: '${'1'.repeat(40)}' }] })
  : real(url, init);`);
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', tsx, '--import', pathToFileURL(preload).href, fileURLToPath(new URL('../src/cli.tsx', import.meta.url)), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, SKILLS_ATLAS_LANG: 'en', SKILLS_ATLAS_OFFLINE: '1', XDG_CONFIG_HOME: join(cwd, 'config'), HOME: home, USERPROFILE: home, GITHUB_TOKEN: 'token' },
  });
  try {
    const json = run('outdated', '-p', '--json');
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual([{ id: 'o/r@p', name: 'p', source: 'o/r', scope: 'project', agents: expect.any(Array) }]);
    const update = run('update', '--dry-run', '-y', '--no-audit', '-a', 'claude-code');
    expect(update.stdout).toContain('add o/r -s p');
    expect(update.stdout).not.toContain(' -g');
    const suggest = run('suggest', '--json');
    expect(suggest.status).toBe(0);
    const found = JSON.parse(suggest.stdout);
    expect(found.stack[0]).toMatchObject({ id: 'react', evidence: ['package.json: react'] });
    expect(found.stack[0].skills.length).toBeGreaterThan(0);
    expect(found.packs).toContain('frontend');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 60_000);
