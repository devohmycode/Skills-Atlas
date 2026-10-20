import { themeAliases } from '../i18n/index.js';
import type { Catalog, Skill, Theme } from '../types.js';

export interface QueryOptions {
  themes?: string[];
  search?: string;
  minInstalls?: number;
  /** Keep skills with no popularity signal at all (hidden by default). */
  all?: boolean;
  /** Only skills published by the vendor itself. */
  official?: boolean;
  /** Only skills whose stated programs are all on this machine (or that state none). */
  ready?: (bin: string) => boolean;
  /** Leave out skills of archived repositories and of those not pushed to for over a year. */
  active?: boolean;
  sort?: SortOrder;
}

/** `installs`: most installed first. `name`: alphabetical. */
export const SORT_ORDERS = ['installs', 'name'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

/** A repository archived, or not pushed to for over a year: its skills are unlikely to be kept up. */
export function isStale(s: Pick<Skill, 'repo'>, now = Date.now()): boolean {
  return !!s.repo && (!!s.repo.archived || (!!s.repo.pushedAt && now - Date.parse(s.repo.pushedAt) > 365 * 86_400_000));
}

/** Returns a sorted copy; skills of stale repositories come after the others (see isStale). */
export function sortSkills(skills: Skill[], order: SortOrder): Skill[] {
  const now = Date.now();
  const stale = new Map(skills.map((s) => [s, isStale(s, now) ? 1 : 0]));
  if (order === 'name') return [...skills].sort((a, b) => stale.get(a)! - stale.get(b)! || a.name.localeCompare(b.name) || a.source.localeCompare(b.source));
  // Stable sort: equal counts (and skills without any) keep the catalog order.
  return [...skills].sort((a, b) => stale.get(a)! - stale.get(b)! || (b.installs ?? 0) - (a.installs ?? 0) || (b.stars ?? 0) - (a.stars ?? 0));
}

/** Matches a theme by id or label in any language, case- and accent-insensitive. */
export function resolveTheme(catalog: Catalog, input: string): Theme | undefined {
  const norm = (s: string) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
  const wanted = norm(input);
  const names = (t: Theme) => themeAliases(t).map(norm);
  return (
    catalog.themes.find((t) => names(t).includes(wanted)) ??
    catalog.themes.find((t) => names(t).some((n) => n.startsWith(wanted)))
  );
}

/** Cached search shared with the browser and offline demo, embedded alongside sortSkills. */
export function createSearchIndex(skills: Skill[]) {
  const entries = skills.map((skill) => ({
    skill,
    name: skill.name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase(),
    text: `${skill.id} ${skill.name} ${skill.description ?? ''} ${(skill.labels ?? []).join(' ')}`.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase(),
  }));
  return (search = '', order?: SortOrder): Skill[] => {
    const query = search.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().trim();
    const terms = query.split(/\s+/).filter(Boolean);
    const found = entries.filter((e) => terms.every((term) => e.text.includes(term)));
    if (query && !order) {
      const scores = new Map(found.map((e) => [e.skill,
        e.name === query ? 3 : e.name.startsWith(query) ? 2 : terms.every((term) => e.name.includes(term)) ? 1 : 0,
      ]));
      const now = Date.now();
      const stale = new Map(found.map((e) => [e.skill, isStale(e.skill, now) ? 1 : 0]));
      // At equal relevance, maintained repositories first.
      found.sort((a, b) => scores.get(b.skill)! - scores.get(a.skill)! || stale.get(a.skill)! - stale.get(b.skill)! || (b.skill.installs ?? 0) - (a.skill.installs ?? 0) || (b.skill.stars ?? 0) - (a.skill.stars ?? 0));
    }
    const result = found.map((e) => e.skill);
    return order ? sortSkills(result, order) : result;
  };
}

/** Every whitespace-separated term must appear in the id, description or labels. */
export function matchesSearch(s: Skill, search: string): boolean {
  return createSearchIndex([s])(search).length > 0;
}

export function querySkills(catalog: Catalog, q: QueryOptions = {}): Skill[] {
  const found = catalog.skills.filter((s) => {
    if (q.official && !s.official) return false;
    if (q.ready && !(s.requires?.bins ?? []).every(q.ready)) return false;
    if (q.active && isStale(s)) return false;
    if (!q.all && !s.recommendation && !s.installs && !s.stars && s.rank === undefined) return false;
    if (q.minInstalls && (s.installs ?? 0) < q.minInstalls) return false;
    if (q.themes?.length && !s.themes.some((t) => q.themes!.includes(t))) return false;
    return true;
  });
  if (q.search?.trim()) return createSearchIndex(found)(q.search, q.sort);
  return q.sort ? sortSkills(found, q.sort) : found;
}

/** Groups skills under each of their themes, keeping catalog theme order. */
export function groupByTheme(themes: Theme[], skills: Skill[]): { theme: Theme; skills: Skill[] }[] {
  const groups = new Map<string, Skill[]>(themes.map((t) => [t.id, []]));
  for (const s of skills) for (const t of s.themes) groups.get(t)?.push(s);
  return themes.map((theme) => ({ theme, skills: groups.get(theme.id)! })).filter((g) => g.skills.length > 0);
}

/** Short popularity label: installs, else stars, else skills.sh rank. */
export function popularityLabel(s: Skill): string {
  if (s.installs) return `↓${formatCount(s.installs)}`;
  if (s.stars) return `★${formatCount(s.stars)}`;
  return s.rank !== undefined ? `#${s.rank}` : '';
}

export function formatCount(n?: number): string {
  if (!n) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
