import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('catalog health CLI', () => {
  it('keeps JSON clean, reports incomplete packs and accepts older snapshots', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'atlas-health-'));
    const cache = join(cwd, 'cache', 'skills-atlas');
    const config = join(cwd, 'config', 'skills-atlas');
    mkdirSync(cache, { recursive: true });
    mkdirSync(config, { recursive: true });
    const catalog = {
      version: 1, generatedAt: '2099-01-01T00:00:00Z', themes: [{ id: 'code', label: 'Code' }],
      skills: [{ id: 'a/b@known', name: 'known', source: 'a/b', installs: 2, labels: [], origins: [], themes: ['code'] }],
      stats: { raw: { 'skills.sh': 1, smithery: 0, 'claude-plugins.dev': 0 }, merged: 1, byTheme: { code: 1 },
        sources: { 'skills.sh': { status: 'ok', count: 1 }, smithery: { status: 'error', count: 0 }, 'claude-plugins.dev': { status: 'ok', count: 0 } },
      },
    };
    const path = join(cache, 'catalog.json.gz');
    writeFileSync(path, JSON.stringify(catalog));
    writeFileSync(join(config, 'packs.json'), JSON.stringify([{ id: 'test', name: 'Test', description: 'Test pack', skills: ['a/b@known', 'x/y@absent'] }]));
    const run = (args: string[]) => spawnSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), resolve('src/launch.ts'), ...args], {
      cwd, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, SKILLS_ATLAS_LANG: 'en', SKILLS_ATLAS_OFFLINE: '1', XDG_CONFIG_HOME: join(cwd, 'config'), XDG_CACHE_HOME: join(cwd, 'cache') },
    });
    const listed = run(['list', '--offline', '--catalog', path, '--json']);
    expect(listed.error).toBeUndefined();
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout).map((group: { theme: { id: string } }) => group.theme.id)).toEqual(['pack:test', 'code']);
    expect(listed.stderr).toContain('Partial catalog: smithery');
    const packs = run(['packs', '--json']);
    expect(packs.status).toBe(0);
    expect(JSON.parse(packs.stdout)).toEqual([expect.objectContaining({ available: 1, total: 2, missing: ['x/y@absent'], skills: ['a/b@known', 'x/y@absent'] })]);
    const legacy = { ...catalog, stats: { raw: catalog.stats.raw, merged: 1, byTheme: { code: 1 } } };
    writeFileSync(path, JSON.stringify(legacy));
    const older = run(['list', '--offline', '--catalog', path, '--json']);
    expect(older.status).toBe(0);
    expect(older.stderr).not.toContain('Partial catalog');
  }, 180_000);
});
