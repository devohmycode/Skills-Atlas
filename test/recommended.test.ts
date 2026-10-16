import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeInstalled } from '../src/catalog/installed.js';
import { querySkills } from '../src/catalog/query.js';
import { readRecommendations, withRecommendations } from '../src/catalog/recommended.js';
import { githubUrl } from '../src/github.js';
import type { Catalog } from '../src/types.js';

const catalog: Catalog = {
  version: 1, generatedAt: '2026-10-15', themes: [{ id: 'coding', label: 'Coding' }], skills: [],
  stats: { raw: { 'skills.sh': 0, smithery: 0, 'claude-plugins.dev': 0 }, merged: 0, byTheme: {} },
};
const pick = { name: 'ponytail', repository: 'https://github.com/DietrichGebert/ponytail', reason: 'Small, maintainable changes.', themes: ['coding'] };

describe('recommendations', () => {
  it('makes a curated skill browsable offline even without popularity', () => {
    const enriched = withRecommendations(catalog, [pick]);
    expect(enriched.themes[0]?.id).toBe('recommended');
    expect(querySkills(enriched).map((s) => s.id)).toEqual(['DietrichGebert/ponytail@ponytail']);
    expect(querySkills(enriched, { themes: ['recommended'] })[0]).toMatchObject({
      recommendation: { repository: pick.repository, reason: pick.reason }, themes: ['recommended', 'coding'],
    });
    expect(querySkills(enriched, { official: true })).toEqual([]);
    expect(catalog.skills).toEqual([]);
  });

  it('preserves catalog identity and metadata, deduplicating case-insensitive picks', () => {
    const existing = {
      id: 'dietrichgebert/ponytail@ponytail', name: 'ponytail', source: 'dietrichgebert/ponytail',
      installs: 42, official: true, labels: [], origins: ['skills.sh'] as ['skills.sh'], themes: ['coding'],
    };
    const enriched = withRecommendations({ ...catalog, skills: [existing] }, [pick, { ...pick, reason: 'Updated reason.' }]);
    expect(enriched.skills).toHaveLength(1);
    expect(enriched.skills[0]).toMatchObject({ id: existing.id, installs: 42, official: true, recommendation: { reason: 'Updated reason.' } });
    const merged = mergeInstalled(enriched.skills, querySkills(enriched), [
      { source: 'DietrichGebert/ponytail', name: 'ponytail', scope: 'global', agents: [] },
    ]);
    expect(merged.skills).toHaveLength(1);
    expect(merged.skills[0]?.themes).toEqual(['installed', 'recommended', 'coding']);
  });

  it('rejects malformed curation instead of creating unsafe installation sources', () => {
    for (const repository of ['https://evil.test/a/b', 'https://github.com/a/b?x=1', 'https://github.com/a/b/extra', 'https://user@github.com/a/b', 'https://github.com/a/.git', 'https://github.com/-owner/repo']) {
      expect(() => withRecommendations(catalog, [{ ...pick, repository }])).toThrow(/recommend/i);
    }
    expect(() => withRecommendations(catalog, [{ ...pick, name: 'bad name' }])).toThrow(/recommend/i);
    expect(() => withRecommendations(catalog, [{ ...pick, name: '--global' }])).toThrow(/recommend/i);
    expect(() => withRecommendations(catalog, [{ ...pick, themes: ['unknown'] }])).toThrow(/theme/i);
  });

  it('turns a pick without a name into the whole repository', () => {
    const { name: _, ...repo } = pick;
    const [skill] = querySkills(withRecommendations(catalog, [repo]));
    expect(skill).toMatchObject({ id: 'DietrichGebert/ponytail@*', name: 'ponytail', source: 'DietrichGebert/ponytail' });
  });

  it('adds a known curated theme missing from an alternative catalog', () => {
    const enriched = withRecommendations({ ...catalog, themes: [] }, [{ ...pick, themes: ['code'] }]);
    expect(enriched.themes.map((th) => th.id)).toEqual(['recommended', 'code']);
    expect(querySkills(enriched, { themes: ['code'] })).toHaveLength(1);
  });

  it('allows a personal JSON list to replace the bundled curation, including an empty list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atlas-curation-'));
    const path = join(dir, 'recommended.json');
    try {
      expect(readRecommendations(path)).toEqual(expect.arrayContaining([expect.objectContaining({ repository: 'https://github.com/DietrichGebert/ponytail' })]));
      writeFileSync(path, JSON.stringify([pick]));
      expect(readRecommendations(path)).toEqual([pick]);
      writeFileSync(path, '[]');
      expect(readRecommendations(path)).toEqual([]);
      writeFileSync(path, '{');
      expect(() => readRecommendations(path)).toThrow(/recommended.json/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('GitHub repository links', () => {
  it('only opens validated owner/repository sources', () => {
    expect(githubUrl({ source: 'DietrichGebert/ponytail' })).toBe('https://github.com/DietrichGebert/ponytail');
    for (const source of ['local', 'https://evil.test', 'a/b?evil', 'a/b/extra', 'a/b;cmd']) {
      expect(githubUrl({ source })).toBeUndefined();
    }
  });
});
