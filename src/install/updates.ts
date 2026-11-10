import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pLimit from 'p-limit';
import { z } from 'zod';
import { fetchJson, HttpError } from '../catalog/http.js';
import type { Scope } from '../types.js';
import { installedSkillPaths, lockPath } from './scan.js';

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
type Tree = z.infer<typeof Tree>;

/** What an update check found: confirmed updates, and the repositories (or skills) it could not check. */
export interface UpdateCheck {
  outdated: Set<string>;
  unchecked: { source: string; reason: string }[];
  /** Project skills whose files no longer match their lock: edited by hand, so never overwritten by an update. */
  modified?: string[];
}

/** Both scopes checked: the confirmed updates of each, and everything that could not be checked. */
export interface ScopedUpdateCheck {
  outdated: Record<Scope, Set<string>>;
  unchecked: UpdateCheck['unchecked'];
  modified: string[];
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
  const { fetched, unchecked } = await headTrees(skills.map((s) => s.source), token);
  const trees = new Map<string, Map<string, string>>();
  const truncated = new Set<string>();
  for (const [source, tree] of fetched) {
    // '' is the repository root, for a skill whose SKILL.md sits there.
    trees.set(source, new Map([['', tree.sha], ...tree.tree.filter((e) => e.type === 'tree').map((e) => [e.path, e.sha] as [string, string])]));
    if (tree.truncated) truncated.add(source);
  }
  for (const s of skills) {
    const tree = trees.get(s.source);
    if (tree && !tree.has(s.dir)) unchecked.push({ source: s.source, reason: `${s.name}: ${truncated.has(s.source) ? 'tree truncated' : `${s.dir} not found`}` });
  }
  return { outdated: outdated(skills, trees), unchecked };
}

/** The HEAD tree of each repository, one Trees API call each, and the repositories that could not be read. */
async function headTrees(sources: string[], token?: string): Promise<{ fetched: Map<string, Tree>; unchecked: UpdateCheck['unchecked'] }> {
  const fetched = new Map<string, Tree>();
  const unchecked: UpdateCheck['unchecked'] = [];
  const limit = pLimit(8);
  await Promise.all(
    [...new Set(sources)].map((source) =>
      limit(async () => {
        try {
          fetched.set(source, Tree.parse(
            await fetchJson(`https://api.github.com/repos/${source}/git/trees/HEAD?recursive=1`, {
              retries: 0,
              timeoutMs: 10_000,
              headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
            }),
          ));
        } catch (err) {
          unchecked.push({ source, reason: reason(err) });
        }
      }),
    ),
  );
  return { fetched, unchecked };
}

/** A GitHub skill of the project lock (`skills-lock.json`), with the content hash the installer computed. */
export interface ProjectLockedSkill {
  name: string;
  source: string;
  dir: string;
  computedHash: string;
}

const ProjectLock = z.object({
  skills: z.record(z.string(), z.object({
    source: z.string().optional(),
    sourceType: z.string().optional(),
    skillPath: z.string().optional(),
    computedHash: z.string().optional(),
    ref: z.string().optional(),
  })),
});

/**
 * GitHub skills of the project lock that can be checked: a source, a skill path and a content hash.
 * A skill installed at a ref is left out: it is pinned (`skills-atlas lock`), its HEAD is not its version.
 */
export function readProjectLockedSkills(path: string): ProjectLockedSkill[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  const lock = ProjectLock.safeParse(raw);
  if (!lock.success) return [];
  return Object.entries(lock.data.skills).flatMap(([name, e]) => {
    if (e.sourceType !== 'github' || !e.source || !/^[\w.-]+\/[\w.-]+$/.test(e.source)) return [];
    if (!e.skillPath || !e.computedHash || e.ref) return [];
    return [{ name, source: e.source, dir: e.skillPath.replace(/\/?SKILL\.md$/i, ''), computedHash: e.computedHash }];
  });
}

/** Files the skills CLI never copies, so never compared. */
const notCopied = (path: string) => {
  const parts = path.split('/');
  return parts.at(-1) === 'metadata.json' || parts.slice(0, -1).some((p) => ['.git', '__pycache__', '__pypackages__'].includes(p));
};

/** Every file of a folder, by path relative to it (`/` separated). */
function readFolder(dir: string, prefix = '', out = new Map<string, Buffer>()): Map<string, Buffer> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) readFolder(join(dir, entry.name), relative + '/', out);
    else if (entry.isFile()) out.set(relative, readFileSync(join(dir, entry.name)));
  }
  return out;
}

/** The content hash the skills CLI writes as `computedHash`: SHA-256 of each path then its bytes, in path order. */
export function computedFolderHash(files: Map<string, Buffer>): string {
  const hash = createHash('sha256');
  const kept = [...files].filter(([path]) => !path.split('/').slice(0, -1).some((p) => p === '.git' || p === 'node_modules'));
  for (const [path, bytes] of kept.sort(([a], [b]) => a.localeCompare(b))) hash.update(path).update(bytes);
  return hash.digest('hex');
}

const blobSha = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * Project skills with a newer version on GitHub. The project lock keeps a content hash, not
 * GitHub's folder hash, so the installed files are compared blob by blob with the repository's
 * HEAD. A copy that differs and no longer matches its lock hash was edited here: it is
 * reported as modified, never as outdated, so an update cannot overwrite the edits.
 */
export async function findProjectUpdates(cwd = process.cwd(), token = githubToken()): Promise<UpdateCheck> {
  const skills = readProjectLockedSkills(lockPath('project', cwd))
    .map((s) => ({ ...s, path: installedSkillPaths('project', cwd, s.name)[0] }))
    .filter((s): s is ProjectLockedSkill & { path: string } => !!s.path);
  const { fetched, unchecked } = await headTrees(skills.map((s) => s.source), token);
  const out = new Set<string>();
  const modified: string[] = [];
  for (const s of skills) {
    const tree = fetched.get(s.source);
    if (!tree) continue;
    const prefix = s.dir ? `${s.dir}/` : '';
    const upstream = new Map(tree.tree
      .filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && !notCopied(e.path.slice(prefix.length)))
      .map((e) => [e.path.slice(prefix.length), e.sha.toLowerCase()]));
    if (!upstream.has('SKILL.md')) {
      unchecked.push({ source: s.source, reason: `${s.name}: ${tree.truncated ? 'tree truncated' : `${s.dir || '/'} not found`}` });
      continue;
    }
    let files: Map<string, Buffer>;
    try {
      files = readFolder(s.path);
    } catch {
      unchecked.push({ source: s.source, reason: `${s.name}: installed folder unreadable` });
      continue;
    }
    const local = [...files].filter(([path]) => !notCopied(path));
    const same = local.length === upstream.size && local.every(([path, bytes]) => upstream.get(path) === blobSha(bytes));
    if (same) continue;
    const id = `${s.source}@${s.name}`.toLowerCase();
    if (computedFolderHash(files) === s.computedHash) out.add(id);
    else modified.push(id);
  }
  return { outdated: out, unchecked, modified };
}

/** Updates of both scopes (or the ones asked), checked together. */
export async function checkUpdates(scopes: Scope[] = ['project', 'global'], cwd = process.cwd(), token = githubToken()): Promise<ScopedUpdateCheck> {
  const none: UpdateCheck = { outdated: new Set(), unchecked: [] };
  const [project, global] = await Promise.all([
    scopes.includes('project') ? findProjectUpdates(cwd, token) : none,
    scopes.includes('global') ? findUpdates(lockPath('global', cwd), token) : none,
  ]);
  return { outdated: { project: project.outdated, global: global.outdated }, unchecked: [...project.unchecked, ...global.unchecked], modified: project.modified ?? [] };
}
