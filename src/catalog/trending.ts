import type { Catalog, Skill, Theme } from '../types.js';

export const TRENDING_THEME: Theme = { id: 'trending', label: 'Trending' };
/** How many skills the Trending theme holds. */
const TOP = 50;

/**
 * Records, on each skill, the installs gained since the previous snapshot
 * (the crawl runs every other day). Returns the previous snapshot's date, or
 * nothing when there is no previous snapshot to compare with.
 */
export function markGrowth(skills: Skill[], previous: Catalog | undefined): string | undefined {
  if (!previous) return undefined;
  const before = new Map(previous.skills.map((s) => [s.id.toLowerCase(), s.installs]));
  for (const s of skills) {
    const was = before.get(s.id.toLowerCase());
    if (s.installs !== undefined && was !== undefined && s.installs > was) s.growth = s.installs - was;
  }
  return previous.generatedAt;
}

/** Growth below this is too small to tell copies apart from coincidence. */
const CLONE_MIN_GROWTH = 1000;
/** Growing skill names two repositories must share to count as copies of each other. */
const CLONE_SHARED_NAMES = 3;
/** Copies a repository must have to be a clone network rather than a fork. */
const CLONE_TWINS = 2;

/**
 * Skills whose growth looks inflated: those of repositories that share at least three
 * growing skill names with at least two other repositories. Copies of one bundle gaining
 * thousands of installs together, with no stars, filled half of Trending; a single fork
 * or a widely used name (code-review, agent-browser) does not reach the threshold.
 */
export function suspectGrowth(skills: Skill[]): Map<string, number> {
  const rising = skills.filter((s) => (s.growth ?? 0) >= CLONE_MIN_GROWTH);
  const names = new Map<string, Set<string>>();
  for (const s of rising) {
    const source = s.source.toLowerCase();
    names.set(source, (names.get(source) ?? new Set()).add(s.name.toLowerCase()));
  }
  const twins = new Map<string, number>();
  const sources = [...names.keys()];
  for (const a of sources) {
    let n = 0;
    for (const b of sources) {
      if (a === b) continue;
      let shared = 0;
      for (const name of names.get(a)!) if (names.get(b)!.has(name) && ++shared >= CLONE_SHARED_NAMES) break;
      if (shared >= CLONE_SHARED_NAMES) n++;
    }
    if (n >= CLONE_TWINS) twins.set(a, n);
  }
  // id -> how many other repositories grow the same skills
  return new Map(rising.filter((s) => twins.has(s.source.toLowerCase())).map((s) => [s.id, twins.get(s.source.toLowerCase())!]));
}

/** The skills that gained the most installs, under a Trending theme placed right after Recommended. */
export function withTrending(catalog: Catalog): Catalog {
  const suspect = suspectGrowth(catalog.skills);
  const rising = catalog.skills.filter((s) => (s.growth ?? 0) > 0 && !suspect.has(s.id)).sort((a, b) => b.growth! - a.growth!).slice(0, TOP);
  if (!rising.length && !suspect.size) return catalog;
  const ids = new Set(rising.map((s) => s.id));
  // Appended, so that a skill keeps its usual theme first (its color on the web page).
  const skills = catalog.skills.map((s) => {
    const copies = suspect.get(s.id);
    const marked = copies ? { ...s, growthSuspect: copies } : s;
    return ids.has(s.id) ? { ...marked, themes: [...marked.themes, TRENDING_THEME.id] } : marked;
  });
  if (!rising.length) return { ...catalog, skills };
  const themes = catalog.themes.filter((th) => th.id !== TRENDING_THEME.id);
  const after = themes.findIndex((th) => th.id === 'recommended') + 1;
  themes.splice(after, 0, TRENDING_THEME);
  return { ...catalog, themes, skills, stats: { ...catalog.stats, byTheme: { ...catalog.stats.byTheme, [TRENDING_THEME.id]: rising.length } } };
}

/** Within Trending, the fastest-growing first. */
export function byGrowth<T extends { growth?: number }>(skills: T[]): T[] {
  return [...skills].sort((a, b) => (b.growth ?? 0) - (a.growth ?? 0));
}
