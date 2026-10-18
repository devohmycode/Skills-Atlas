import { describe, expect, it } from 'vitest';
import { byGrowth, markGrowth, withTrending } from '../src/catalog/trending.js';
import type { Catalog, Skill } from '../src/types.js';

const skill = (id: string, installs?: number): Skill => {
  const [source, name] = id.split('@') as [string, string];
  return { id, name, source, installs, labels: [], origins: [], themes: ['code'] };
};
const catalog = (skills: Skill[], generatedAt = '2026-10-17'): Catalog => ({
  version: 1, generatedAt, skills,
  themes: [{ id: 'recommended', label: 'Recommended' }, { id: 'code', label: 'Code' }],
  stats: { raw: { 'skills.sh': 0, smithery: 0, 'claude-plugins.dev': 0 }, merged: skills.length, byTheme: {} },
});

describe('trending', () => {
  it('records the installs gained since the previous snapshot', () => {
    const now = [skill('a/b@up', 150), skill('a/b@flat', 80), skill('a/b@down', 10), skill('a/b@new', 500), skill('a/b@nocount')];
    const since = markGrowth(now, catalog([skill('A/B@up', 100), skill('a/b@flat', 80), skill('a/b@down', 20), skill('a/b@nocount', 5)], '2026-10-15'));
    expect(since).toBe('2026-10-15');
    expect(now.map((s) => s.growth)).toEqual([50, undefined, undefined, undefined, undefined]);
    expect(markGrowth(now, undefined)).toBeUndefined();
  });

  it('puts the fastest-growing skills under Trending, right after Recommended', () => {
    const skills = [{ ...skill('a/b@slow', 9000), growth: 5 }, { ...skill('a/b@fast', 100), growth: 90 }, skill('a/b@still', 50)];
    const trending = withTrending(catalog(skills));
    expect(trending.themes.map((th) => th.id)).toEqual(['recommended', 'trending', 'code']);
    expect(trending.skills.find((s) => s.name === 'fast')!.themes).toEqual(['code', 'trending']);
    expect(trending.skills.find((s) => s.name === 'still')!.themes).toEqual(['code']);
    expect(trending.stats.byTheme.trending).toBe(2);
    expect(byGrowth(trending.skills.filter((s) => s.themes.includes('trending'))).map((s) => s.name)).toEqual(['fast', 'slow']);
    // No growth recorded (an older snapshot): no Trending theme at all.
    expect(withTrending(catalog([skill('a/b@x', 1)])).themes.map((th) => th.id)).toEqual(['recommended', 'code']);
  });
});
