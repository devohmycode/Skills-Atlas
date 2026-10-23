import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { fetchJson } from '../catalog/http.js';
import { configPath } from '../config.js';
import { checkRevision } from './plan.js';
import { lockPath } from './scan.js';
import { githubToken, readLockedSkills, type LockedSkill } from './updates.js';

/**
 * The versions a global skill had before its updates, newest last, so that
 * `rollback` can reinstall one. Kept next to the config, five per skill.
 */
export interface PastRevision {
  revision: string;
  /** When that version was replaced. */
  replacedAt: string;
}

const KEEP = 5;
const History = z.record(z.string(), z.array(z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/i), replacedAt: z.string() })));

export const historyPath = (): string => join(dirname(configPath()), 'history.json');
/** Commits skills-atlas installed exactly (a rollback), with the folder hash the lock recorded then. */
export const knownPath = (): string => join(dirname(configPath()), 'revisions.json');
const Known = z.record(z.string(), z.object({ revision: z.string().regex(/^[a-f0-9]{40}$/i), hash: z.string() }));

export function readHistory(path = historyPath()): Record<string, PastRevision[]> {
  try {
    const parsed = History.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function writeHistory(history: object, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(history, null, 2)}\n`);
  renameSync(tmp, path);
}

export function pushRevision(id: string, revision: string, path = historyPath(), now = new Date()): void {
  const history = readHistory(path);
  const key = id.toLowerCase();
  const list = (history[key] ?? []).filter((r) => r.revision !== revision);
  history[key] = [...list, { revision: checkRevision(revision), replacedAt: now.toISOString() }].slice(-KEEP);
  writeHistory(history, path);
}

/** Forgets a revision once it is installed again: the next rollback goes one further back. */
export function dropRevision(id: string, revision: string, path = historyPath()): void {
  const history = readHistory(path);
  const key = id.toLowerCase();
  if (!history[key]) return;
  history[key] = history[key].filter((r) => r.revision !== revision);
  if (!history[key].length) delete history[key];
  writeHistory(history, path);
}

function readKnown(path: string): z.infer<typeof Known> {
  try {
    const parsed = Known.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/**
 * After an install at an exact commit succeeded: ties that commit to the folder hash the
 * lock now records, so it is still known after a restart. A skill missing from the lock is skipped.
 */
export function rememberRevision(id: string, revision: string, lock = lockPath('global', process.cwd()), path = knownPath()): void {
  const s = readLockedSkills(lock).find((l) => `${l.source}@${l.name}`.toLowerCase() === id.toLowerCase());
  if (!s) return;
  const known = readKnown(path);
  known[id.toLowerCase()] = { revision: checkRevision(revision), hash: s.hash };
  writeHistory(known, path);
}

const Commits = z.array(z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }));
const CommitTree = z.object({ sha: z.string(), truncated: z.boolean().optional(), tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() })) });

/**
 * The commit a skill was installed from, only when it is proven: a commit skills-atlas
 * installed while the lock still records the same folder hash, the installer's own ref,
 * or the last commit touching the folder before the install date whose folder hash
 * matches the lock's. Anything else is undefined: a date alone does not prove a version.
 */
export async function installedRevision(skill: LockedSkill, token = githubToken(), known = knownPath()): Promise<string | undefined> {
  const remembered = readKnown(known)[`${skill.source}@${skill.name}`.toLowerCase()];
  if (remembered?.hash === skill.hash) return remembered.revision.toLowerCase();
  if (skill.ref) return skill.ref;
  if (!skill.date) return undefined;
  const headers = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const params = new URLSearchParams({ until: skill.date, per_page: '1', ...(skill.dir ? { path: skill.dir } : {}) });
  const commits = Commits.safeParse(await fetchJson(`https://api.github.com/repos/${skill.source}/commits?${params}`, { retries: 1, timeoutMs: 10_000, headers }));
  const candidate = commits.success ? commits.data[0]?.sha.toLowerCase() : undefined;
  if (!candidate) return undefined;
  // Asked by commit SHA, the Trees API answers with the root tree: its SHA is a root skill's folder hash.
  const tree = CommitTree.safeParse(await fetchJson(`https://api.github.com/repos/${skill.source}/git/trees/${candidate}${skill.dir ? '?recursive=1' : ''}`, { retries: 1, timeoutMs: 10_000, headers }));
  if (!tree.success) return undefined;
  const folder = skill.dir ? tree.data.tree.find((e) => e.type === 'tree' && e.path === skill.dir)?.sha : tree.data.sha;
  return folder === skill.hash ? candidate : undefined;
}

/**
 * Before updating global skills: record the version each one has now. A skill whose
 * version cannot be found is updated all the same, without a way back.
 */
export async function recordBeforeUpdate(ids: string[], lock = lockPath('global', process.cwd()), path = historyPath(),
  resolve: (s: LockedSkill) => Promise<string | undefined> = installedRevision): Promise<string[]> {
  const locked = readLockedSkills(lock);
  const missed: string[] = [];
  for (const id of ids) {
    const s = locked.find((l) => `${l.source}@${l.name}`.toLowerCase() === id.toLowerCase());
    const revision = s && (await resolve(s).catch(() => undefined));
    if (revision) pushRevision(id, revision, path);
    else missed.push(id);
  }
  return missed;
}
