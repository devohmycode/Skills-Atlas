import type { Catalog, Origin, RawSkill } from '../types.js';
import { classifyAll } from './classify.js';
import { compareSkills, dedupe } from './dedupe.js';
import { enrichDescriptions } from './enrich.js';
import { fetchClaudePluginsDev } from './sources/claude-plugins-dev.js';
import { fetchOfficialOwners, markOfficial } from './sources/official.js';
import { fetchSkillsSh } from './sources/skills-sh.js';
import { fetchSmithery } from './sources/smithery.js';
import { allThemes } from './taxonomy.js';

export interface BuildOptions {
  maxSkillsShOwners?: number;
  /** How many popular skills without description to complete from GitHub (0 = none). */
  enrich?: number;
  githubToken?: string;
  log?: (msg: string) => void;
}

/**
 * Classifies and sorts merged skills, flags the official ones when the list
 * of official owners is known, then wraps them with stats.
 */
export function assemble(
  raw: Record<Origin, RawSkill[]>,
  merged = dedupe(Object.values(raw).flat()),
  officialOwners?: Set<string>,
): Catalog {
  const skills = classifyAll(merged);
  const official = officialOwners ? markOfficial(skills, officialOwners) : undefined;
  skills.sort(compareSkills);
  const byTheme: Record<string, number> = {};
  for (const s of skills) for (const t of s.themes) byTheme[t] = (byTheme[t] ?? 0) + 1;
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    themes: allThemes(),
    skills,
    stats: {
      raw: {
        'skills.sh': raw['skills.sh'].length,
        'claude-plugins.dev': raw['claude-plugins.dev'].length,
        smithery: raw.smithery.length,
      },
      merged: skills.length,
      official,
      byTheme,
    },
  };
}

/**
 * Crawls every source. A failing source is logged and skipped so that one
 * registry being down does not block the snapshot; all of them failing does.
 */
export async function buildCatalog(opts: BuildOptions = {}): Promise<Catalog> {
  const log = opts.log ?? (() => {});
  const jobs: Record<Origin, () => Promise<RawSkill[]>> = {
    'skills.sh': () => fetchSkillsSh({ maxOwners: opts.maxSkillsShOwners, log }),
    'claude-plugins.dev': () => fetchClaudePluginsDev(log),
    smithery: () => fetchSmithery(log),
  };
  const origins = Object.keys(jobs) as Origin[];
  // The official flag is optional: without officialskills.sh the snapshot is still built.
  const officialOwners = fetchOfficialOwners(log).catch((err: unknown) => {
    log(`officialskills.sh: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
  const settled = await Promise.allSettled(origins.map((o) => jobs[o]()));
  const raw = {} as Record<Origin, RawSkill[]>;
  settled.forEach((r, i) => {
    const origin = origins[i]!;
    if (r.status === 'fulfilled') {
      raw[origin] = r.value;
      log(`${origin}: ${r.value.length} entries`);
    } else {
      raw[origin] = [];
      log(`${origin}: FAILED — ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
  });
  if (settled.every((r) => r.status === 'rejected')) throw new Error('every catalog source failed');
  let merged = dedupe(Object.values(raw).flat());
  if (opts.enrich) {
    const { filled, missing } = await enrichDescriptions(merged, { max: opts.enrich, githubToken: opts.githubToken, log });
    // Installing a skill its repository no longer has can only fail.
    merged = merged.filter((s) => !missing.has(s));
    log(`enrich: ${filled} descriptions filled, ${missing.size} skills gone from their repository dropped`);
  }
  return assemble(raw, merged, await officialOwners);
}
