import type { Origin, RawSkill, Skill } from '../types.js';
import { normalizeName, skillDir } from './normalize.js';

const ORIGIN_ORDER: Origin[] = ['skills.sh', 'claude-plugins.dev', 'smithery'];

function maxDefined(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Merges the raw entries of every source into one skill per `owner/repo@name`
 * (case-insensitive). Numeric fields keep the maximum, labels and origins are
 * unioned, the longest description wins. Themes are left empty for `classify`.
 */
export function dedupe(raw: RawSkill[]): Skill[] {
  const byKey = new Map<string, Skill>();
  for (const r of raw) {
    const key = `${r.source.toLowerCase()}@${normalizeName(r.name)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        id: `${r.source}@${r.name}`,
        name: r.name,
        source: r.source,
        path: r.path === undefined ? undefined : skillDir(r.path),
        description: r.description,
        installs: r.installs,
        stars: r.stars,
        rank: r.rank,
        labels: [...new Set(r.labels ?? [])],
        origins: [r.origin],
        themes: [],
      });
      continue;
    }
    existing.path ??= r.path === undefined ? undefined : skillDir(r.path);
    if (r.description && (!existing.description || r.description.length > existing.description.length)) {
      existing.description = r.description;
    }
    existing.installs = maxDefined(existing.installs, r.installs);
    existing.stars = maxDefined(existing.stars, r.stars);
    if (r.rank !== undefined) existing.rank = Math.min(existing.rank ?? Infinity, r.rank);
    for (const l of r.labels ?? []) if (!existing.labels.includes(l)) existing.labels.push(l);
    if (!existing.origins.includes(r.origin)) {
      existing.origins.push(r.origin);
      existing.origins.sort((a, b) => ORIGIN_ORDER.indexOf(a) - ORIGIN_ORDER.indexOf(b));
    }
  }
  return [...byKey.values()];
}

/** Popularity used for sorting: installs first, stars as a tie-breaker. */
export function popularity(s: Pick<Skill, 'installs' | 'stars'>): number {
  return (s.installs ?? 0) * 10 + (s.stars ?? 0);
}

/**
 * Sort order of the catalog. Skills ranked by skills.sh (its sitemaps list
 * the most installed first) come first in that order: their install counts
 * dwarf those of other directories. The rest follow by installs and stars.
 */
export function compareSkills(a: Skill, b: Skill): number {
  if (a.rank !== undefined || b.rank !== undefined) {
    return (a.rank ?? Infinity) - (b.rank ?? Infinity) || popularity(b) - popularity(a);
  }
  return popularity(b) - popularity(a) || a.id.localeCompare(b.id);
}
