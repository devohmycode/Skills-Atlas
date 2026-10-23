import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

it('install rejects a skill name that would reach npx skills as a flag, before any command', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'atlas-install-cli-'));
  const preload = join(cwd, 'guard.mjs');
  // Any network call or child process would mean the bad id got past validation.
  writeFileSync(preload, `globalThis.fetch = async (url) => { throw Error('unexpected fetch ' + url); };`);
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  const run = (...args: string[]) => spawnSync(process.execPath, ['--import', tsx, '--import', pathToFileURL(preload).href, fileURLToPath(new URL('../src/cli.tsx', import.meta.url)), ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, SKILLS_ATLAS_LANG: 'en', SKILLS_ATLAS_OFFLINE: '1', XDG_CONFIG_HOME: join(cwd, 'config') },
  });
  try {
    const bad = run('install', 'o/r@x', 'o/r@--global', '--agent', 'codex', '--project', '--symlink', '--yes', '--no-audit', '--dry-run');
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('invalid skill name in "o/r@--global"');
    expect(bad.stdout).not.toContain('npx');
    const good = run('install', 'o/r@x', '--agent', 'codex', '--project', '--symlink', '--yes', '--no-audit', '--dry-run');
    expect(good.stderr).toBe('');
    expect(good.stdout).toContain('add o/r -s x -a codex -y --json');
    expect(good.stdout).not.toContain(' -g');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 60_000);
