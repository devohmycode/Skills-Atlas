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

/** The skills that gained the most installs, under a Trending theme placed right after Recommended. */
export function withTrending(catalog: Catalog): Catalog {
  const rising = catalog.skills.filter((s) => (s.growth ?? 0) > 0).sort((a, b) => b.growth! - a.growth!).slice(0, TOP);
  if (!rising.length) return catalog;
  const ids = new Set(rising.map((s) => s.id));
  // Appended, so that a skill keeps its usual theme first (its color on the web page).
  const skills = catalog.skills.map((s) => (ids.has(s.id) ? { ...s, themes: [...s.themes, TRENDING_THEME.id] } : s));
  const themes = catalog.themes.filter((th) => th.id !== TRENDING_THEME.id);
  const after = themes.findIndex((th) => th.id === 'recommended') + 1;
  themes.splice(after, 0, TRENDING_THEME);
  return { ...catalog, themes, skills, stats: { ...catalog.stats, byTheme: { ...catalog.stats.byTheme, [TRENDING_THEME.id]: rising.length } } };
}

/** Within Trending, the fastest-growing first. */
export function byGrowth<T extends { growth?: number }>(skills: T[]): T[] {
  return [...skills].sort((a, b) => (b.growth ?? 0) - (a.growth ?? 0));
}
