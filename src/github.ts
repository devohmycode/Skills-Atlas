import { checkRevision } from './install/plan.js';
import { openBrowser } from './browser.js';
import { guessPaths } from './catalog/enrich.js';
import pLimit from 'p-limit';
import { z } from 'zod';
import { fetchJson, fetchText } from './catalog/http.js';
import { githubToken } from './install/updates.js';
import { isValidSource, skillDir } from './catalog/normalize.js';
import type { Skill } from './types.js';

/** Local skills do not have a repository to open. */
export function githubUrl(skill: Pick<Skill, 'source'>): string | undefined {
  if (!isValidSource(skill.source) || skill.source.split('/').some((part) => part === '.' || part === '..')) return undefined;
  return `https://github.com/${skill.source}`;
}

export function openGitHub(skill: Pick<Skill, 'source'>): void {
  const url = githubUrl(skill);
  if (url) openBrowser(url);
}

/**
 * A skill's SKILL.md from its repository, at its known path or the usual ones.
 * The text is untrusted: control characters and escape sequences are removed
 * so that it cannot drive the terminal it is shown in.
 */
export async function fetchSkillMarkdown(skill: Pick<Skill, 'source' | 'name' | 'path'>, revision?: string): Promise<string> {
  if (!githubUrl(skill)) throw new Error('no GitHub repository');
  const ref = revision === undefined ? 'HEAD' : checkRevision(revision);
  let lastError: unknown = new Error('SKILL.md not found');
  // skillDir: snapshots older than its fix may hold the SKILL.md's own path.
  for (const dir of skill.path !== undefined ? [skillDir(skill.path)] : guessPaths(skill.name)) {
    if (revision !== undefined && (dir.split('/').some(p => p === '.' || p === '..') || /[?#\\\u0000-\u001f]/.test(dir))) throw new Error('invalid pinned skill path');
    try {
      const path = revision === undefined ? dir : dir.split('/').map(encodeURIComponent).join('/');
      const url = `https://raw.githubusercontent.com/${skill.source}/${ref}/${path ? `${path}/` : ''}SKILL.md`;
      return stripControls(await fetchText(url, { retries: 1, timeoutMs: 15_000 }));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Keeps printable text, line breaks and tabs (as spaces); drops ANSI/OSC sequences and other control characters. */
export function stripControls(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}

/** The text files a skill ships besides its SKILL.md, read for the security audit. */
export interface SkillFiles {
  files: { path: string; text: string }[];
  /** Files left unread: binaries, too large, past the limit. */
  skipped: string[];
}

const TEXT = /\.(sh|bash|zsh|fish|ps1|psm1|bat|cmd|py|js|mjs|cjs|ts|rb|pl|php|lua|md|txt|json|ya?ml|toml|ini|cfg|env)$|(^|\/)(Makefile|Dockerfile|[^./]+)$/i;
const MAX_BYTES = 64 * 1024;
const MAX_FILES = 30;
const FileTree = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), size: z.number().optional() })),
});
const trees = new Map<string, Promise<z.infer<typeof FileTree>>>();

/**
 * Lists a skill's folder with the Trees API (one call per repository and revision,
 * shared by the skills of one run) and fetches its text files, a few at a time.
 * Skipped files are reported, never treated as audited.
 */
export async function fetchSkillFiles(skill: Pick<Skill, 'source' | 'name' | 'path'>, revision?: string): Promise<SkillFiles> {
  if (!githubUrl(skill)) throw new Error('no GitHub repository');
  if (skill.path === undefined) return { files: [], skipped: [] }; // shortcut: no known folder, only the SKILL.md is audited
  const ref = revision === undefined ? 'HEAD' : checkRevision(revision);
  const key = `${skill.source}@${ref}`;
  if (!trees.has(key)) {
    const token = githubToken();
    trees.set(key, fetchJson(`https://api.github.com/repos/${skill.source}/git/trees/${ref}?recursive=1`, {
      retries: 1, timeoutMs: 15_000,
      headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    }).then((t) => FileTree.parse(t)).catch((err: unknown) => { trees.delete(key); throw err; }));
  }
  const tree = await trees.get(key)!;
  const dir = skillDir(skill.path);
  const prefix = dir ? `${dir}/` : '';
  const skipped: string[] = [];
  const wanted: string[] = [];
  for (const e of tree.tree) {
    if (e.type !== 'blob' || !e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    if (/^SKILL\.md$/i.test(rel) || rel.split('/').some((p) => p === '.git' || p === 'node_modules')) continue;
    if (!TEXT.test(rel) || (e.size ?? 0) > MAX_BYTES || wanted.length >= MAX_FILES) skipped.push(rel);
    else wanted.push(rel);
  }
  if (tree.truncated) skipped.push('(repository too large to list completely)');
  const limit = pLimit(6);
  const files = await Promise.all(wanted.map((rel) => limit(async () => {
    const url = `https://raw.githubusercontent.com/${skill.source}/${ref}/${(prefix + rel).split('/').map(encodeURIComponent).join('/')}`;
    try {
      return { path: rel, text: stripControls(await fetchText(url, { retries: 1, timeoutMs: 15_000 })) };
    } catch {
      skipped.push(rel);
      return undefined;
    }
  })));
  return { files: files.filter((f) => f !== undefined), skipped };
}
