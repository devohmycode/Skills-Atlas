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

export function readHistory(path = historyPath()): Record<string, PastRevision[]> {
  try {
    const parsed = History.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

function writeHistory(history: Record<string, PastRevision[]>, path: string): void {
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

const Commits = z.array(z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }));

/**
 * The commit a skill was installed from: the last one touching its folder before the
 * lock's install or update date, which was the repository's HEAD then.
 * shortcut: a force-push since then can point elsewhere; compare the folder's tree SHA if that matters.
 */
export async function installedRevision(skill: LockedSkill, token = githubToken()): Promise<string | undefined> {
  if (!skill.date) return undefined;
  const params = new URLSearchParams({ until: skill.date, per_page: '1', ...(skill.dir ? { path: skill.dir } : {}) });
  const commits = Commits.safeParse(await fetchJson(`https://api.github.com/repos/${skill.source}/commits?${params}`, {
    retries: 1, timeoutMs: 10_000,
    headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  }));
  return commits.success ? commits.data[0]?.sha : undefined;
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
