import type { InstalledSkill } from './install/run.js';
import { installedSkillPaths } from './install/scan.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { z } from 'zod';
import { fetchJson } from './catalog/http.js';
import { checkRevision, parseSkillId } from './install/plan.js';
import { parseSelectionFile } from './selection.js';

export type Revisions = Record<string, string>;

export function revisionChanges(ids: string[], previous: Revisions, revisions: Revisions) {
  return ids.map(id => {
    const before = previous[id.toLowerCase()];
    const revision = revisions[id]!;
    const source = parseSkillId(id).source;
    return { id, previous: before, revision, compare: before && before !== revision ? `https://github.com/${source}/compare/${before}...${revision}` : undefined };
  });
}

/** Resolve everything before replacing the manifest; failures never leave a partial lock. */
export async function lockSelection(path: string, dryRun: boolean, resolve: (source: string) => Promise<string> = resolveHead) {
  const original = readFileSync(path, 'utf8');
  const file = parseSelectionFile(original);
  const ids = [...new Map(file.ids.map(id => [id.toLowerCase(), id])).values()];
  const repos = new Map<string, string>();
  const revisions: Revisions = {};
  for (const id of ids) {
    const source = parseSkillId(id).source.toLowerCase();
    if (!repos.has(source)) repos.set(source, checkRevision(await resolve(source)));
    revisions[id] = repos.get(source)!;
  }
  const changes = revisionChanges(ids, file.revisions ?? {}, revisions);
  if (!dryRun) {
    if (readFileSync(path, 'utf8') !== original) throw new Error('manifest changed while resolving revisions; retry lock');
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify({ ...JSON.parse(original), revisions }, null, 2) + '\n', { flag: 'wx' });
      renameSync(temp, path);
    } finally { rmSync(temp, { force: true }); }
  }
  return changes;
}

async function resolveHead(source: string): Promise<string> {
  parseSkillId(`${source}@skill`);
  const result = await fetchJson<{ sha?: unknown }>(`https://api.github.com/repos/${source}/commits/HEAD`, { retries: 1 });
  return checkRevision(result.sha);
}

const Tree = z.object({
  truncated: z.literal(false),
  tree: z.array(z.object({ path: z.string(), type: z.string(), mode: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/i) })),
});
const excluded = (path: string) => path.split('/').some(p => ['.git', '__pycache__', '__pypackages__', 'metadata.json'].includes(p));

/** All installed copies must match Git blob hashes, including supporting files and extra files. */
export async function verifyRevision(id: string, revision: string, skillPath: string, paths: string[]): Promise<boolean> {
  const { source } = parseSkillId(id);
  checkRevision(revision);
  if (!skillPath || !/(^|\/)SKILL\.md$/i.test(skillPath) || skillPath.split('/').some(p => !p || p === '.' || p === '..') || /[\\\u0000-\u001f?#]/.test(skillPath)) {
    throw new Error(`cannot verify ${id}: invalid skill path`);
  }
  const result = Tree.safeParse(await fetchJson(`https://api.github.com/repos/${source}/git/trees/${revision}?recursive=1`, { retries: 1 }));
  if (!result.success) throw new Error(`cannot verify ${id}: incomplete or invalid Git tree`);
  const dir = posix.dirname(skillPath);
  const prefix = dir === '.' ? '' : dir + '/';
  const expected = new Map<string, string>();
  for (const entry of result.data.tree) {
    if (!entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length);
    if (!relative || excluded(relative)) continue;
    if (relative.split('/').some(p => !p || p === '.' || p === '..') || relative.includes('\\')) throw new Error(`cannot verify ${id}: invalid tree path`);
    if (entry.type === 'tree') continue;
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`cannot verify ${id}: symbolic links or submodules are unsupported`);
    expected.set(relative, entry.sha.toLowerCase());
  }
  if (!expected.has('SKILL.md')) throw new Error(`cannot verify ${id}: SKILL.md missing at pinned revision`);
  if (!paths.length) return false;
  for (const path of paths) {
    const actual = new Map<string, string>();
    const collect = (dir: string, prefix = '') => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix + entry.name;
        if (entry.isDirectory()) collect(join(dir, entry.name), relative + '/');
        else if (entry.isFile()) {
          const bytes = readFileSync(join(dir, entry.name));
          actual.set(relative, createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'));
        } else throw new Error(`cannot verify ${id}: unsupported installed file ${relative}`);
      }
    };
    try { collect(path); } catch (err) { throw new Error(`cannot verify ${id}: ${(err as Error).message}`); }
    if (actual.size !== expected.size || [...expected].some(([name, hash]) => actual.get(name) !== hash)) return false;
  }
  return true;
}

/** Presence stays the default; pinned entries additionally require a verifiable project lock and matching bytes. */
export async function projectRevisionDrift(ids: string[], revisions: Revisions, installed: InstalledSkill[], cwd = process.cwd()): Promise<string[]> {
  const pinned = ids.filter(id => revisions[id.toLowerCase()] && installed.some(s => `${s.source}@${s.name}`.toLowerCase() === id.toLowerCase()));
  if (!pinned.length) return [];
  let lock: { skills?: Record<string, { ref?: unknown; skillPath?: unknown; source?: unknown }> };
  try { lock = JSON.parse(readFileSync(join(cwd, 'skills-lock.json'), 'utf8')); }
  catch { throw new Error('cannot verify pinned skills: unreadable project lock'); }
  const drift: string[] = [];
  for (const id of pinned) {
    const { source, name } = parseSkillId(id);
    const revision = checkRevision(revisions[id.toLowerCase()]);
    const entry = Object.entries(lock.skills ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (!entry || typeof entry.skillPath !== 'string' || !entry.skillPath || typeof entry.ref !== 'string') throw new Error(`cannot verify ${id}: project lock lacks ref or skillPath`);
    if (entry.ref.toLowerCase() !== revision || typeof entry.source !== 'string' || entry.source.toLowerCase() !== source.toLowerCase()) { drift.push(id); continue; }
    if (!await verifyRevision(id, revision, entry.skillPath, installedSkillPaths('project', cwd, name))) drift.push(id);
  }
  return drift;
}
