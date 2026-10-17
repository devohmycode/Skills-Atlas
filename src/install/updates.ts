import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import pLimit from 'p-limit';
import { z } from 'zod';
import { fetchJson } from '../catalog/http.js';
import { lockPath } from './scan.js';

/** A skill of the global lock file, with the git tree SHA of its folder when it was installed. */
export interface LockedSkill {
  name: string;
  /** `owner/repo` on GitHub. */
  source: string;
  /** Folder of the skill inside its repository. */
  dir: string;
  hash: string;
}

const Lock = z.object({
  skills: z.record(z.string(), z.object({
    source: z.string().optional(),
    sourceType: z.string().optional(),
    skillPath: z.string().optional(),
    skillFolderHash: z.string().optional(),
  })),
});
const Tree = z.object({ tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() })) });

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
    return [{ name, source: e.source, dir: e.skillPath.replace(/\/?SKILL\.md$/i, ''), hash: e.skillFolderHash }];
  });
}

/** `owner/repo@name` (lower case) of the skills whose folder SHA differs from their repository's (`source → path → sha`). */
export function outdated(skills: LockedSkill[], trees: Map<string, Map<string, string>>): Set<string> {
  const out = new Set<string>();
  for (const s of skills) {
    const sha = trees.get(s.source)?.get(s.dir);
    // No SHA: repository unreachable, skill moved, or a skill at the repository root.
    if (sha && sha !== s.hash) out.add(`${s.source}@${s.name}`.toLowerCase());
  }
  return out;
}

/** GITHUB_TOKEN or GH_TOKEN, else the GitHub CLI's token when it is logged in. */
function githubToken(): string | undefined {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Globally installed skills with a newer version on GitHub: one Trees API call
 * per repository. A repository that cannot be read reports nothing.
 * shortcut: without a token GitHub allows 60 calls an hour, so many repositories
 * checked twice in an hour go silent; cache the trees if that gets in the way.
 */
export async function findUpdates(path = lockPath('global', process.cwd()), token = githubToken()): Promise<Set<string>> {
  const skills = readLockedSkills(path);
  const trees = new Map<string, Map<string, string>>();
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
          trees.set(source, new Map(tree.tree.filter((e) => e.type === 'tree').map((e) => [e.path, e.sha])));
        } catch {
          // Unreachable, private or rate limited: no news for this repository.
        }
      }),
    ),
  );
  return outdated(skills, trees);
}
