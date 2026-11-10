import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('creates a profile, shows what activating it would do without touching anything, and has no backup to restore yet', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'atlas-profile-cli-'));
  const home = join(cwd, 'home');
  mkdirSync(join(cwd, '.claude', 'skills', 'mine'), { recursive: true });
  writeFileSync(join(cwd, '.claude', 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\n');
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', tsx, fileURLToPath(new URL('../src/cli.tsx', import.meta.url)), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, SKILLS_ATLAS_LANG: 'en', SKILLS_ATLAS_OFFLINE: '1', XDG_CONFIG_HOME: join(cwd, 'config'), XDG_STATE_HOME: join(cwd, 'state'), HOME: home, USERPROFILE: home },
  });
  try {
    const created = run('profile', 'create', 'My Docs', 'anthropics/skills@pdf', 'nobody/none@x');
    expect(created.status).toBe(0);
    expect(created.stdout).toContain('Pack my-docs created with 1 skills');
    expect(created.stderr).toContain('nobody/none@x');
    expect(JSON.parse(readFileSync(join(cwd, 'config', 'skills-atlas', 'packs.json'), 'utf8')).at(-1)).toMatchObject({ id: 'my-docs', skills: ['anthropics/skills@pdf'] });
    expect(JSON.parse(run('profile', 'list', '--json').stdout).map((p: { id: string }) => p.id)).toContain('my-docs');
    const plan = run('profile', 'use', 'my-docs', '-p', '--dry-run', '-a', 'claude-code');
    expect(plan.stdout).toContain('− local@mine');
    expect(plan.stdout).toContain('+ anthropics/skills@pdf');
    expect(plan.stdout).toContain('npx -y skills@1.7.0 remove -s mine -y');
    expect(plan.stdout).toContain('npx -y skills@1.7.0 add anthropics/skills -s pdf -a claude-code -y --json');
    // A dry run neither saves nor removes anything.
    expect(existsSync(join(cwd, 'state'))).toBe(false);
    expect(existsSync(join(cwd, '.claude', 'skills', 'mine', 'SKILL.md'))).toBe(true);
    // Without a terminal, a real change needs -y.
    expect(run('profile', 'use', 'my-docs', '-p', '-a', 'claude-code').stderr).toContain('pass -y');
    const restore = run('profile', 'restore', '-y');
    expect(restore.status).toBe(1);
    expect(restore.stderr).toContain('No backup yet');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 60_000);
