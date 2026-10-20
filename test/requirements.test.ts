import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrichRequirements } from '../src/catalog/requirements.js';
import { querySkills } from '../src/catalog/query.js';
import type { Catalog, Skill } from '../src/types.js';

const skill = (name: string, extra: Partial<Skill> = {}): Skill =>
  ({ id: `o/r@${name}`, name, source: 'o/r', path: `skills/${name}`, labels: [], origins: [], themes: ['code'], installs: 10, ...extra });

afterEach(() => vi.unstubAllGlobals());

describe('catalog prerequisites', () => {
  it('reads programs and compatibility, dates the folder, and keeps what the previous crawl knew', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      if (url.includes('/commits?')) return Response.json([{ commit: { committer: { date: '2026-09-30T12:00:00Z' } } }]);
      if (url.endsWith('/skills/a/SKILL.md')) return new Response('---\nname: a\ncompatibility: Needs network\nmetadata: {"requires":{"bins":["gh"]}}\n---\n');
      if (url.endsWith('/skills/b/SKILL.md')) return new Response('---\nname: b\n---\n');
      return new Response('nope', { status: 404 });
    });
    const skills = [skill('a', { installs: 30 }), skill('b', { installs: 20, requires: { bins: ['old'] } }), skill('c', { installs: 1 }), skill('d', { path: undefined })];
    const previous = { skills: [skill('c', { requires: { bins: ['jq'] }, updatedAt: '2026-01-01' })] } as Catalog;
    const r = await enrichRequirements(skills, { max: 3, maxDates: 1, githubToken: 't', previous });
    expect(skills[0]).toMatchObject({ requires: { bins: ['gh'], compatibility: 'Needs network' }, updatedAt: '2026-09-30' });
    expect(skills[1]!.requires).toBeUndefined();
    expect(skills[2]).toMatchObject({ requires: { bins: ['jq'] }, updatedAt: '2026-01-01' });
    expect(r).toEqual({ read: 2, dated: 1 });
    expect(urls.filter((u) => u.includes('/commits?'))).toEqual(['https://api.github.com/repos/o/r/commits?per_page=1&path=skills%2Fa']);
  });

  it('filters on programs present here, keeping skills that state none', () => {
    const catalog = { skills: [skill('a', { requires: { bins: ['gh'] } }), skill('b', { requires: { bins: ['missing'] } }), skill('c')] } as Catalog;
    expect(querySkills(catalog, { ready: (b) => b === 'gh' }).map((s) => s.name)).toEqual(['a', 'c']);
  });
});
