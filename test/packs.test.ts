import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { curated } from '../src/catalog/curated.js';
import { readPacks, withPacks } from '../src/catalog/packs.js';
import type { Catalog, Skill } from '../src/types.js';

const skill = (id: string): Skill => {
  const [source, name] = id.split('@') as [string, string];
  return { id, name, source, installs: 10, labels: [], origins: [], themes: ['code'] };
};
const catalog: Catalog = {
  version: 1, generatedAt: '2026-10-18', skills: [skill('a/b@one'), skill('a/b@two'), skill('c/d@three')],
  themes: [{ id: 'recommended', label: 'Recommended' }, { id: 'trending', label: 'Trending' }, { id: 'code', label: 'Code' }],
  stats: { raw: { 'skills.sh': 0, smithery: 0, 'claude-plugins.dev': 0 }, merged: 3, byTheme: {} },
};

describe('packs', () => {
  it('turns each pack into a theme after Trending, holding the skills the catalog knows', () => {
    const packed = withPacks(catalog, [{ id: 'web', name: 'Web dev', description: 'For the web.', skills: ['A/B@one', 'c/d@three', 'x/y@unknown'] }]);
    expect(packed.themes.map((th) => th.id)).toEqual(['recommended', 'trending', 'pack:web', 'code']);
    expect(packed.themes[2]).toEqual({ id: 'pack:web', label: '📦 Web dev', description: 'For the web.' });
    expect(packed.skills.filter((s) => s.themes.includes('pack:web')).map((s) => s.id)).toEqual(['a/b@one', 'c/d@three']);
    expect(packed.stats.byTheme['pack:web']).toBe(2);
  });

  it('ships packs whose skills all exist in the bundled catalog, without a name twice in a pack', async () => {
    const packs = readPacks(join(tmpdir(), 'no-such-packs.json'));
    const { loadCatalog } = await import('../src/catalog/load.js');
    const ids = new Set((await loadCatalog()).skills.map((s) => s.id.toLowerCase()));
    for (const p of packs) {
      expect(p.skills.filter((id) => !ids.has(id.toLowerCase())), p.id).toEqual([]);
      const names = p.skills.map((id) => id.split('@')[1]);
      expect(new Set(names).size, p.id).toBe(names.length);
    }
    expect(curated({ ...catalog, skills: [] }).themes.some((th) => th.id.startsWith('pack:'))).toBe(true);
  });

  it('refuses a personal pack file that could inject flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-packs-'));
    try {
      writeFileSync(join(dir, 'packs.json'), JSON.stringify([{ id: 'x', name: 'X', description: 'x', skills: ['a/b@--global'] }]));
      expect(() => readPacks(join(dir, 'packs.json'))).toThrow(/packs/);
      writeFileSync(join(dir, 'packs.json'), '[]');
      expect(readPacks(join(dir, 'packs.json'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
