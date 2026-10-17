import pLimit from 'p-limit';
import { z } from 'zod';
import type { Skill } from '../types.js';
import { compareSkills } from './dedupe.js';
import { fetchJson, fetchText, HttpError } from './http.js';
import { frontmatterDescription } from './normalize.js';

const Tree = z.object({ tree: z.array(z.object({ path: z.string(), type: z.string() })), truncated: z.boolean().optional() });

/** Usual places of a skill inside its repository, tried when there is no GitHub token. */
export function guessPaths(name: string): string[] {
  return [`skills/${name}`, name, `.claude/skills/${name}`, `plugins/${name}/skills/${name}`, `.agents/skills/${name}`];
}

/** Picks the directory of `name` among the SKILL.md files of a repository tree. */
export function findSkillDir(paths: string[], name: string): string | undefined {
  const wanted = name.toLowerCase();
  const dirs = paths
    .filter((p) => /(^|\/)SKILL\.md$/i.test(p))
    .map((p) => p.replace(/\/?SKILL\.md$/i, ''));
  const matches = dirs.filter((d) => d.split('/').pop()!.toLowerCase() === wanted);
  // Several copies (plugins, mirrors…): the shortest path is usually the canonical one.
  return matches.sort((a, b) => a.length - b.length)[0] ?? (dirs.length === 1 && dirs[0] === '' ? '' : undefined);
}

export interface EnrichOptions {
  /** How many skills without description to try, most popular first. */
  max: number;
  /** GitHub token for the Trees API; without one, usual paths are guessed. */
  githubToken?: string;
  log?: (msg: string) => void;
}

export interface EnrichResult {
  /** Descriptions filled. */
  filled: number;
  /** Skills absent from their repository's tree: renamed or deleted since the registries listed them. */
  missing: Set<Skill>;
}

/**
 * Fills missing descriptions (and paths) from each skill's SKILL.md on GitHub.
 * With a token, one Trees API call per repository locates every SKILL.md;
 * the files themselves come from raw.githubusercontent.com, which is not
 * subject to the API rate limit. Mutates the skills; the same tree reveals
 * the skills that no longer exist.
 */
export async function enrichDescriptions(skills: Skill[], opts: EnrichOptions): Promise<EnrichResult> {
  const log = opts.log ?? (() => {});
  const targets = skills.filter((s) => !s.description).sort(compareSkills).slice(0, opts.max);
  const bySource = new Map<string, Skill[]>();
  for (const s of targets) bySource.set(s.source, [...(bySource.get(s.source) ?? []), s]);

  const limit = pLimit(8);
  let filled = 0;
  const missing = new Set<Skill>();
  let repos = 0;
  let stopped = false;

  const readSkill = async (skill: Skill, dir: string): Promise<boolean> => {
    const url = `https://raw.githubusercontent.com/${skill.source}/HEAD/${dir ? `${dir}/` : ''}SKILL.md`;
    try {
      const description = frontmatterDescription(await fetchText(url, { retries: 1 }));
      if (!description) return false;
      skill.description = description;
      // '' is a skill at the repository root: a known path, not a missing one.
      skill.path ??= dir;
      filled++;
      return true;
    } catch (err) {
      if (err instanceof HttpError && err.status === 429) stopped = true;
      return false;
    }
  };

  await Promise.all(
    [...bySource.entries()].map(([source, list]) =>
      limit(async () => {
        if (stopped) return;
        try {
          if (opts.githubToken) {
            const tree = Tree.parse(
              await fetchJson(`https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`, {
                retries: 1,
                headers: { authorization: `Bearer ${opts.githubToken}`, accept: 'application/vnd.github+json' },
              }),
            );
            const paths = tree.tree.filter((e) => e.type === 'blob').map((e) => e.path);
            // A truncated tree may simply not list the skill: only a complete one proves it gone.
            const complete = !tree.truncated && paths.some((p) => /(^|\/)SKILL\.md$/i.test(p));
            for (const skill of list) {
              const dir = skill.path ?? findSkillDir(paths, skill.name);
              // shortcut: matches the directory name, not the frontmatter name; a skill whose
              // directory is named otherwise is dropped too. Read the frontmatters if that shows up.
              if (dir === undefined && complete) missing.add(skill);
              else if (dir !== undefined) await readSkill(skill, dir);
            }
          } else {
            for (const skill of list) {
              const candidates = skill.path ? [skill.path] : guessPaths(skill.name);
              for (const dir of candidates) if (stopped || (await readSkill(skill, dir))) break;
            }
          }
        } catch (err) {
          // 403/429 on the Trees API means the token quota is spent: stop there.
          if (err instanceof HttpError && (err.status === 403 || err.status === 429)) {
            stopped = true;
            log(`enrich: GitHub rate limit reached after ${repos} repositories, stopping`);
          }
        } finally {
          if (++repos % 250 === 0) log(`enrich: ${repos}/${bySource.size} repositories, ${filled} descriptions`);
        }
      }),
    ),
  );
  return { filled, missing };
}
