import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { diagnoseInstalled } from '../src/install/doctor.js';

function project() {
  const cwd = mkdtempSync(join(tmpdir(), 'atlas-doctor-'));
  const dir = join(cwd, '.agents', 'skills');
  mkdirSync(dir, { recursive: true });
  return { cwd, dir, lock: join(cwd, 'skills-lock.json') };
}

describe('installation doctor', () => {
  it('accepts an empty project and a healthy installation without changing files', () => {
    const { cwd, dir, lock } = project();
    expect(diagnoseInstalled('project', cwd)).toEqual([]);
    mkdirSync(join(dir, 'pdf'));
    writeFileSync(join(dir, 'pdf', 'SKILL.md'), '---\nname: PDF\n---\nTools');
    const contents = JSON.stringify({ version: 1, skills: { pdf: { source: 'a/b' } } });
    writeFileSync(lock, contents);
    writeFileSync(join(dir, 'notes.txt'), 'an ordinary file');
    expect(diagnoseInstalled('project', cwd)).toEqual([]);
    expect(readFileSync(lock, 'utf8')).toBe(contents);
  });

  it('reports missing SKILL.md and stale lock entries once for shared directories', () => {
    const { cwd, dir, lock } = project();
    mkdirSync(join(dir, 'incomplete'));
    writeFileSync(lock, JSON.stringify({ skills: { gone: { source: 'a/b' } } }));
    expect(diagnoseInstalled('project', cwd)).toEqual([
      { scope: 'project', code: 'missing-skill-md', path: join(dir, 'incomplete', 'SKILL.md') },
      { scope: 'project', code: 'stale-lock-entry', path: lock, name: 'gone' },
    ]);
  });

  it.each(['not json', 'null', '{"skills":[]}', '{"skills":{"pdf":3}}', '{"skills":{"pdf":{"source":42}}}'])('reports an invalid lock: %s', (contents) => {
    const { cwd, lock } = project();
    writeFileSync(lock, contents);
    expect(diagnoseInstalled('project', cwd)).toEqual([{ scope: 'project', code: 'invalid-lock', path: lock }]);
    expect(readFileSync(lock, 'utf8')).toBe(contents);
  });

  it('reports dangling directory links without following them outside the skills root', () => {
    const { cwd, dir } = project();
    const path = join(dir, 'broken');
    symlinkSync(join(cwd, 'missing'), path, process.platform === 'win32' ? 'junction' : 'dir');
    expect(diagnoseInstalled('project', cwd)).toEqual([{ scope: 'project', code: 'broken-link', path }]);
  });

  it('ignores a valid symlink to an ordinary file', (context) => {
    const { cwd, dir } = project();
    const file = join(cwd, 'notes.txt');
    writeFileSync(file, 'notes');
    try { symlinkSync(file, join(dir, 'notes.txt'), 'file'); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'EPERM') { context.skip(); return; } throw err; }
    expect(diagnoseInstalled('project', cwd)).toEqual([]);
  });

  it('reports an unreadable SKILL.md path', () => {
    const { cwd, dir } = project();
    mkdirSync(join(dir, 'bad', 'SKILL.md'), { recursive: true });
    expect(diagnoseInstalled('project', cwd)).toEqual([{ scope: 'project', code: 'unreadable-skill', path: join(dir, 'bad', 'SKILL.md') }]);
  });

  it('exposes read-only JSON diagnostics, exit codes and shell completion through the CLI', () => {
    const { cwd, lock } = project();
    const run = (args: string[]) => spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/launch.ts'), ...args], {
      cwd, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, SKILLS_ATLAS_LANG: 'en', XDG_CONFIG_HOME: join(cwd, 'config') },
    });
    const healthy = run(['doctor', '-p', '--json']);
    expect(healthy.error).toBeUndefined();
    expect(healthy.status).toBe(0);
    expect(JSON.parse(healthy.stdout)).toEqual([]);
    writeFileSync(lock, 'broken');
    const broken = run(['doctor', '-p', '--json']);
    expect(broken.status).toBe(1);
    expect(JSON.parse(broken.stdout)).toEqual([{ scope: 'project', code: 'invalid-lock', path: lock, message: 'Invalid skill lock file' }]);
    expect(run(['__complete', '--', 'doc']).stdout.trim()).toBe('doctor');
    expect(readFileSync(lock, 'utf8')).toBe('broken');
  }, 90_000);
});
