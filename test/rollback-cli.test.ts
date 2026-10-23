import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { installedRevision, pushRevision, readHistory, recordBeforeUpdate, rememberRevision } from '../src/install/history.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);

afterEach(() => vi.unstubAllGlobals());

it('after a rollback to A while main is at B, the next update records A, even after a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-rollback-'));
  const lock = join(dir, 'lock.json'), history = join(dir, 'history.json'), known = join(dir, 'revisions.json');
  const writeLock = (hash: string, updatedAt: string) => writeFileSync(lock, JSON.stringify({ skills: {
    x: { source: 'o/r', sourceType: 'github', skillPath: 'skills/x/SKILL.md', skillFolderHash: hash, updatedAt },
  } }));
  // GitHub: the folder last changed in B (hash hB); A had hash hA.
  vi.stubGlobal('fetch', async (url: string) => Response.json(url.includes('/commits?') ? [{ sha: B }]
    : { sha: 'root', tree: [{ path: 'skills/x', type: 'tree', sha: url.includes(B) ? 'hB' : 'hA' }] }));
  const resolve = (s: Parameters<typeof installedRevision>[0]) => installedRevision(s, '', known);
  try {
    // Update from B: B is proven by its folder hash and recorded.
    writeLock('hB', '2026-10-01T00:00:00Z');
    expect(await recordBeforeUpdate(['o/r@x'], lock, history, resolve)).toEqual([]);
    // Rollback reinstalls A: the lock now has hA and a recent date that a date lookup would map to B.
    writeLock('hA', '2026-10-20T00:00:00Z');
    rememberRevision('o/r@x', A, lock, known);
    // Restart: nothing in memory, only the files. The next update records A, never B.
    expect(await recordBeforeUpdate(['o/r@x'], lock, history, resolve)).toEqual([]);
    expect(readHistory(history)['o/r@x']!.at(-1)!.revision).toBe(A);
    // Updated again elsewhere (hash differs from what was remembered), and no proof on GitHub: no way back.
    writeLock('hC', '2026-10-22T00:00:00Z');
    expect(await recordBeforeUpdate(['o/r@x'], lock, history, resolve)).toEqual(['o/r@x']);
    // Offline: the version cannot be proven either.
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    expect(await recordBeforeUpdate(['o/r@x'], lock, history, resolve)).toEqual(['o/r@x']);
    expect(readHistory(history)['o/r@x']!.map((r) => r.revision)).toEqual([B, A]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('rollback --dry-run records nothing', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'atlas-rollback-cli-'));
  const config = join(cwd, 'config');
  const home = join(cwd, 'home');
  const skill = join(home, '.agents', 'skills', 'x');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: x\n---\nsafe');
  writeFileSync(join(home, '.agents', '.skill-lock.json'), JSON.stringify({ version: 3, skills: {
    x: { source: 'o/r', sourceType: 'github', skillPath: 'skills/x/SKILL.md', skillFolderHash: 'hB', updatedAt: '2026-10-01T00:00:00Z' },
  } }));
  const preload = join(cwd, 'fetch.mjs');
  writeFileSync(preload, `globalThis.fetch = async url => {
    if (String(url).startsWith('https://raw.githubusercontent.com/o/r/${A}/')) return new Response('---\\nname: x\\n---\\nsafe');
    return new Response('', { status: 404 });
  };`);
  const historyFile = join(config, 'skills-atlas', 'history.json');
  mkdirSync(join(config, 'skills-atlas'), { recursive: true });
  pushRevision('o/r@x', A, historyFile);
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  try {
    const res = spawnSync(process.execPath, ['--import', tsx, '--import', pathToFileURL(preload).href, fileURLToPath(new URL('../src/cli.tsx', import.meta.url)), 'rollback', 'o/r@x', '--dry-run', '--symlink'], {
      cwd, encoding: 'utf8', env: { ...process.env, SKILLS_ATLAS_LANG: 'en', SKILLS_ATLAS_OFFLINE: '1', XDG_CONFIG_HOME: config, HOME: home, USERPROFILE: home },
    });
    expect(res.stdout + res.stderr).toContain(`https://github.com/o/r/tree/${A}`);
    expect(readHistory(historyFile)['o/r@x']!.map((r) => r.revision)).toEqual([A]);
    expect(existsSync(join(config, 'skills-atlas', 'revisions.json'))).toBe(false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 60_000);

it('remembers nothing for a skill the lock does not have', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-rollback-'));
  try {
    writeFileSync(join(dir, 'lock.json'), JSON.stringify({ skills: {} }));
    rememberRevision('o/r@x', C, join(dir, 'lock.json'), join(dir, 'revisions.json'));
    expect(existsSync(join(dir, 'revisions.json'))).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
