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
