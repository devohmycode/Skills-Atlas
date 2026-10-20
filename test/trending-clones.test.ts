import { describe, expect, it } from 'vitest';
import { suspectGrowth, withTrending } from '../src/catalog/trending.js';
import type { Catalog, Skill } from '../src/types.js';

const skill = (source: string, name: string, growth: number): Skill =>
  ({ id: `${source}@${name}`, name, source, labels: [], origins: [], themes: ['code'], installs: growth * 10, growth });

describe('inflated growth', () => {
  const bundle = ['ai-avatar-video', 'ai-image-generation', 'twitter-automation', 'agent-browser'];
  const clones = ['a/superpowers', 'b/superpowers', 'c/superpowers'].flatMap((src, i) => bundle.map((n) => skill(src, n, 10_000 * (i + 1))));
  const honest = [skill('vercel-labs/agent-browser', 'agent-browser', 6000), skill('mattpocock/skills', 'code-review', 6500),
    skill('fork/skills', 'ai-avatar-video', 5000), skill('fork/skills', 'ai-image-generation', 5000), skill('tiny/x', 'ai-avatar-video', 900)];

  it('flags repositories that grow the same skills as two others, and only those', () => {
    const suspect = suspectGrowth([...clones, ...honest]);
    expect([...suspect.keys()].sort()).toEqual(clones.map((s) => s.id).sort());
    expect(suspect.get('a/superpowers@ai-avatar-video')).toBe(2);
  });

  it('keeps flagged skills out of Trending and marks them', () => {
    const catalog = { version: 1, generatedAt: '', themes: [{ id: 'recommended', label: 'R' }], skills: [...clones, ...honest], stats: { byTheme: {} } } as unknown as Catalog;
    const out = withTrending(catalog);
    const trending = out.skills.filter((s) => s.themes.includes('trending')).map((s) => s.id);
    expect(trending).toEqual(expect.arrayContaining(honest.map((s) => s.id)));
    expect(trending.some((id) => id.includes('superpowers'))).toBe(false);
    expect(out.skills.find((s) => s.id === 'c/superpowers@twitter-automation')!.growthSuspect).toBe(2);
  });
});
