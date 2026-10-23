import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pLimit from 'p-limit';
import { z } from 'zod';
import { fetchJson, HttpError } from '../catalog/http.js';
import { lockPath } from './scan.js';

/** A skill of the global lock file, with the git tree SHA of its folder when it was installed. */
export interface LockedSkill {
  name: string;
  /** `owner/repo` on GitHub. */
  source: string;
  /** Folder of the skill inside its repository. */
  dir: string;
  hash: string;
  /** When it was last installed or updated, per the lock. */
  date?: string;
  /** The exact commit, when the installer recorded one. */
  ref?: string;
}

const Lock = z.object({
  skills: z.record(z.string(), z.object({
    source: z.string().optional(),
    sourceType: z.string().optional(),
    skillPath: z.string().optional(),
    skillFolderHash: z.string().optional(),
    ref: z.string().optional(),
    installedAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })),
});
const Tree = z.object({ sha: z.string(), truncated: z.boolean().optional(), tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() })) });

/** What an update check found: confirmed updates, and the repositories (or skills) it could not check. */
export interface UpdateCheck {
  outdated: Set<string>;
  unchecked: { source: string; reason: string }[];
}

/**
 * GitHub skills of a lock file that recorded their folder hash. Only the global
 * lock does: the project one keeps a content hash GitHub cannot be compared with.
 */
export function readLockedSkills(path: string): LockedSkill[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const lock = Lock.safeParse(raw);
  if (!lock.success) return [];
  return Object.entries(lock.data.skills).flatMap(([name, e]) => {
    if (e.sourceType !== 'github' || !e.source || !/^[\w.-]+\/[\w.-]+$/.test(e.source)) return [];
    if (!e.skillPath || !e.skillFolderHash) return [];
    return [{ name, source: e.source, dir: e.skillPath.replace(/\/?SKILL\.md$/i, ''), hash: e.skillFolderHash, date: e.updatedAt ?? e.installedAt, ...(e.ref && /^[a-f0-9]{40}$/i.test(e.ref) ? { ref: e.ref.toLowerCase() } : {}) }];
  });
}

/** `owner/repo@name` (lower case) of the skills whose folder SHA differs from their repository's (`source → path → sha`). */
export function outdated(skills: LockedSkill[], trees: Map<string, Map<string, string>>): Set<string> {
  const out = new Set<string>();
  for (const s of skills) {
    const sha = trees.get(s.source)?.get(s.dir);
    // No SHA: repository unreachable or skill moved, reported by findUpdates as unchecked.
    if (sha && sha !== s.hash) out.add(`${s.source}@${s.name}`.toLowerCase());
  }
  return out;
}

/** GITHUB_TOKEN or GH_TOKEN, else the GitHub CLI's token when it is logged in. */
export function githubToken(): string | undefined {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Why a repository could not be checked, without the URL or any header. */
function reason(err: unknown): string {
  if (err instanceof HttpError) return `HTTP ${err.status}`;
  if (err instanceof z.ZodError || err instanceof SyntaxError) return 'invalid response';
  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) return 'timed out';
  return 'unreachable';
}

/**
 * Globally installed skills with a newer version on GitHub: one Trees API call
 * per repository. A repository that cannot be read, a truncated tree or a skill
 * folder GitHub no longer has is reported as unchecked, never as up to date.
 * shortcut: without a token GitHub allows 60 calls an hour, so many repositories
 * checked twice in an hour fail with HTTP 403; cache the trees if that gets in the way.
 */
export async function findUpdates(path = lockPath('global', process.cwd()), token = githubToken()): Promise<UpdateCheck> {
  const skills = readLockedSkills(path);
  const trees = new Map<string, Map<string, string>>();
  const truncated = new Set<string>();
  const unchecked: UpdateCheck['unchecked'] = [];
  const limit = pLimit(8);
  await Promise.all(
    [...new Set(skills.map((s) => s.source))].map((source) =>
      limit(async () => {
        try {
          const tree = Tree.parse(
            await fetchJson(`https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`, {
              retries: 0,
              timeoutMs: 10_000,
              headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
            }),
          );
          // '' is the repository root, for a skill whose SKILL.md sits there.
          trees.set(source, new Map([['', tree.sha], ...tree.tree.filter((e) => e.type === 'tree').map((e) => [e.path, e.sha] as [string, string])]));
          if (tree.truncated) truncated.add(source);
        } catch (err) {
          unchecked.push({ source, reason: reason(err) });
        }
      }),
    ),
  );
  for (const s of skills) {
    const tree = trees.get(s.source);
    if (tree && !tree.has(s.dir)) unchecked.push({ source: s.source, reason: `${s.name}: ${truncated.has(s.source) ? 'tree truncated' : `${s.dir} not found`}` });
  }
  return { outdated: outdated(skills, trees), unchecked };
}
