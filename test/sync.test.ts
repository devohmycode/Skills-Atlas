import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENTS } from '../src/agents.js';

const launcher = resolve('node_modules/tsx/dist/cli.mjs');
const cli = resolve('src/launch.ts');

function project(agents?: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'atlas-sync-'));
  const skillDir = join(cwd, AGENTS.find((a) => a.id === 'cursor')!.projectDir, 'pdf');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: pdf\n---\nPDF tools');
  writeFileSync(join(cwd, 'skills-lock.json'), JSON.stringify({ skills: { pdf: { source: 'a/b' } } }));
  writeFileSync(join(cwd, 'skills-atlas.json'), JSON.stringify({ skillsAtlas: 1, skills: ['a/b@pdf'], agents }));
  return cwd;
}

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [launcher, cli, 'sync', ...args], {
    cwd, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, SKILLS_ATLAS_LANG: 'en', SKILLS_ATLAS_OFFLINE: '1', XDG_CONFIG_HOME: join(cwd, 'config') },
  });
}

describe('sync CLI targets', () => {
  it('checks the requested agent and lets -a override the manifest', () => {
    const cwd = project(['cursor', 'claude-code']);
    const missing = run(cwd, ['--check']);
    expect(missing.error).toBeUndefined();
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain('a/b@pdf  [claude-code]');
    expect(missing.stdout).not.toContain('[cursor]');
    expect(run(cwd, ['--check', '-a', 'cursor']).status).toBe(0);
  }, 60_000);

  it('retains project-wide checking without targets and validates unknown agents early', () => {
    const cwd = project();
    expect(run(cwd, ['--check']).status).toBe(0);
    const invalid = run(cwd, ['--check', '-a', 'not-an-agent']);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('unknown agent(s): not-an-agent');
  }, 60_000);

  it('plans only the missing destination without running an install', () => {
    const cwd = project(['cursor', 'claude-code']);
    const result = run(cwd, ['--dry-run', '--no-audit', '-y']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('add a/b -s pdf -a claude-code');
    expect(result.stdout).not.toContain('-a cursor');
  }, 60_000);
});
