import pLimit from 'p-limit';
import { z } from 'zod';
import { prerequisites } from '../prereqs.js';
import type { Catalog, Skill } from '../types.js';
import { compareSkills } from './dedupe.js';
import { fetchJson, fetchText, HttpError } from './http.js';

export interface RequirementsOptions {
  /** How many skills to read, most popular first; the others keep the previous snapshot's values. */
  max: number;
  /** How many of them get their last change date (one GitHub API call each, token required). */
  maxDates: number;
  githubToken?: string;
  previous?: Catalog;
  log?: (msg: string) => void;
}

const Commits = z.array(z.object({ commit: z.object({ committer: z.object({ date: z.string() }).nullable() }) }));

/**
 * Records what each skill says it needs (`requires.bins`, `compatibility`) and when its
 * folder last changed, so that the catalog shows them before anything is read. SKILL.md
 * files come from raw.githubusercontent.com (no API quota); dates from the commits API.
 * Mutates the skills.
 */
export async function enrichRequirements(skills: Skill[], opts: RequirementsOptions): Promise<{ read: number; dated: number }> {
  const log = opts.log ?? (() => {});
  // What the previous crawl knew stays, for the skills this one does not reach.
  const before = new Map(opts.previous?.skills.map((s) => [s.id.toLowerCase(), s]));
  for (const s of skills) {
    const was = before.get(s.id.toLowerCase());
    if (was?.requires) s.requires ??= was.requires;
    if (was?.updatedAt) s.updatedAt ??= was.updatedAt;
  }
  const targets = skills.filter((s) => s.path !== undefined).sort(compareSkills).slice(0, opts.max);
  const limit = pLimit(16);
  let read = 0;
  let dated = 0;
  let stopped = false;
  await Promise.all(targets.map((s, i) => limit(async () => {
    const dir = s.path ? `${s.path}/` : '';
    try {
      const pre = prerequisites(await fetchText(`https://raw.githubusercontent.com/${s.source}/HEAD/${dir}SKILL.md`, { retries: 1, timeoutMs: 15_000 }));
      const requires = { ...(pre.bins ? { bins: pre.bins.names } : {}), ...(pre.compatibility ? { compatibility: pre.compatibility.text } : {}) };
      if (Object.keys(requires).length) s.requires = requires;
      else delete s.requires;
      read++;
    } catch {
      // Unreadable now: the previous value, if any, stays.
    }
    if (i >= opts.maxDates || !opts.githubToken || stopped) return;
    try {
      const params = new URLSearchParams({ per_page: '1', ...(s.path ? { path: s.path } : {}) });
      const commits = Commits.parse(await fetchJson(`https://api.github.com/repos/${s.source}/commits?${params}`, {
        retries: 1, headers: { authorization: `Bearer ${opts.githubToken}`, accept: 'application/vnd.github+json' },
      }));
      const date = commits[0]?.commit.committer?.date.slice(0, 10);
      if (date) {
        s.updatedAt = date;
        dated++;
      }
    } catch (err) {
      if (err instanceof HttpError && (err.status === 403 || err.status === 429)) {
        stopped = true;
        log(`requirements: GitHub rate limit reached after ${dated} dates, stopping`);
      }
    }
  })));
  return { read, dated };
}
