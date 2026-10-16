import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import bundled from '../../data/recommended.json' with { type: 'json' };
import { configPath } from '../config.js';
import type { Catalog, Skill, Theme } from '../types.js';
import { allThemes } from './taxonomy.js';
import { isValidSource } from './normalize.js';

export const RECOMMENDED_THEME: Theme = { id: 'recommended', label: 'Recommended' };

const repositoryPattern = /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+?)\/?$/i;
const Recommendations = z.array(z.object({
  /** Without a name, the pick is the whole repository: every catalog skill it holds. */
  name: z.string().regex(/^(?!-)[A-Za-z0-9_.-]+$/).optional(),
  repository: z.string().regex(repositoryPattern),
  reason: z.string().trim().min(1),
  description: z.string().optional(),
  path: z.string().optional(),
  themes: z.array(z.string()).optional(),
}));
export type Recommendation = z.infer<typeof Recommendations>[number];

/** A personal list replaces the shipped selection; [] deliberately disables it. */
export function readRecommendations(path = join(dirname(configPath()), 'recommended.json')): Recommendation[] {
  try {
    return parseRecommendations(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseRecommendations(bundled);
    throw new Error(`Could not read recommendations from ${path}`, { cause: error });
  }
}

function parseRecommendations(raw: unknown): Recommendation[] {
  const result = Recommendations.safeParse(raw);
  if (!result.success) throw new Error(`Invalid recommendations: ${result.error.message}`);
  return result.data;
}

/** Merge at runtime so a downloaded snapshot never removes the personal selection. */
export function withRecommendations(catalog: Catalog, raw: unknown = readRecommendations()): Catalog {
  const picks = parseRecommendations(raw);
  if (!picks.length) return catalog;
  const byId = new Map(catalog.skills.map((s) => [s.id.toLowerCase(), s]));
  const themes = new Map(catalog.themes.map((th) => [th.id, th]));
  const knownThemes = new Map(allThemes().map((th) => [th.id, th]));
  for (const [order, pick] of picks.entries()) {
    const match = repositoryPattern.exec(pick.repository)!;
    const source = `${match[1]}/${match[2]!.replace(/\.git$/i, '')}`;
    if (!isValidSource(source) || source.split('/').some((part) => part === '.' || part === '..')) throw new Error('Invalid recommendation repository');
    for (const id of pick.themes ?? []) {
      if (themes.has(id)) continue;
      const theme = knownThemes.get(id);
      if (!theme) throw new Error(`Unknown recommendation theme for ${pick.name}: ${id}`);
      themes.set(id, theme);
    }
    const recommendation = { repository: `https://github.com/${source}`, reason: pick.reason, order };
    if (!pick.name) {
      // The real catalog skills, so installed ones are detected and each installs on its own.
      for (const [key, skill] of byId) {
        if (skill.source.toLowerCase() !== source.toLowerCase() || skill.recommendation) continue;
        byId.set(key, { ...skill, recommendation, themes: [...new Set(['recommended', ...skill.themes])] });
      }
      continue;
    }
    const id = `${source}@${pick.name}`;
    const existing = byId.get(id.toLowerCase());
    const base: Skill = existing ?? {
      id, name: pick.name, source, description: pick.description, path: pick.path,
      labels: [], origins: [], themes: pick.themes ?? [],
    };
    byId.set(id.toLowerCase(), {
      ...base,
      description: base.description || pick.description,
      path: base.path ?? pick.path,
      recommendation,
      themes: [...new Set(['recommended', ...base.themes, ...(pick.themes ?? [])])],
    });
  }
  const skills = [...byId.values()];
  const byTheme: Record<string, number> = {};
  for (const skill of skills) for (const id of skill.themes) byTheme[id] = (byTheme[id] ?? 0) + 1;
  return {
    ...catalog,
    themes: [RECOMMENDED_THEME, ...[...themes.values()].filter((th) => th.id !== 'recommended')],
    skills,
    stats: { ...catalog.stats, merged: skills.length, byTheme },
  };
}
