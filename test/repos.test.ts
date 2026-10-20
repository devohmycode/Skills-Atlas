import { describe, expect, it } from 'vitest';
import { enrichRepositories } from '../src/catalog/repos.js';
import { isStale, querySkills, sortSkills } from '../src/catalog/query.js';
import type { Catalog, Skill } from '../src/types.js';

const skill = (source: string, name: string, extra: Partial<Skill> = {}): Skill =>
  ({ id: `${source}@${name}`, name, source, labels: [], origins: [], themes: ['code'], installs: 100, ...extra });

describe('repository quality', () => {
  it('reads license, archive state and last push in GraphQL batches, keeping older values', async () => {
    const bodies: string[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return Response.json({ data: {
        r0: { isArchived: true, pushedAt: '2024-01-02T00:00:00Z', stargazerCount: 7, licenseInfo: { spdxId: 'MIT' } },
        r1: null,
      } });
    }) as typeof globalThis.fetch;
    const skills = [skill('a/old', 'x', { installs: 900 }), skill('b/gone', 'y'), skill('c/known', 'z', { installs: 1 })];
    const previous = { skills: [skill('c/known', 'z', { repo: { license: 'Apache-2.0' } })] } as Catalog;
    expect(await enrichRepositories(skills, { githubToken: 't', max: 2, previous, fetch })).toBe(1);
    expect(skills[0]).toMatchObject({ repo: { license: 'MIT', archived: true, pushedAt: '2024-01-02' }, stars: 7 });
    expect(skills[1]!.repo).toBeUndefined();
    expect(skills[2]!.repo).toEqual({ license: 'Apache-2.0' });
    expect(bodies[0]).toContain('r0: repository(owner: \\"a\\", name: \\"old\\")');
    expect(bodies[0]).not.toContain('c/known');
  });

  it('puts stale repositories last and can leave them out', () => {
    const now = Date.parse('2026-10-20');
    expect(isStale({ repo: { pushedAt: '2025-10-01' } }, now)).toBe(true);
    expect(isStale({ repo: { pushedAt: '2026-01-01' } }, now)).toBe(false);
    expect(isStale({ repo: { archived: true } }, now)).toBe(true);
    expect(isStale({}, now)).toBe(false);
    const skills = [skill('a/a', 'archived', { installs: 900, repo: { archived: true } }), skill('b/b', 'kept', { installs: 10 }), skill('c/c', 'none', {})];
    expect(sortSkills(skills, 'installs').map((s) => s.name)).toEqual(['none', 'kept', 'archived']);
    expect(querySkills({ skills } as Catalog, { active: true }).map((s) => s.name)).toEqual(['archived', 'kept', 'none'].filter((n) => n !== 'archived'));
  });
});
