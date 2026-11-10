import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchSkillFiles, fetchSkillMarkdown, isTextFile, stripControls, type SkillFiles } from '../github.js';
import { scanRisks, sortRisks, unaudited, type Risk } from '../risks.js';
import type { Skill } from '../types.js';
import { listInstalled, type InstalledSkill } from './run.js';

export interface DiffLine {
  kind: '+' | '-' | ' ';
  text: string;
}

/** Above this many line pairs the diff is not computed line by line. */
const MAX_CELLS = 4_000_000;

/** A line diff by longest common subsequence: SKILL.md files are a few hundred lines. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  // shortcut: very long files show as replaced whole, which is honest but coarse; use Myers if that shows up.
  if (a.length * b.length > MAX_CELLS) return [...a.map((text) => ({ kind: '-' as const, text })), ...b.map((text) => ({ kind: '+' as const, text }))];
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i]! });
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push({ kind: '+', text: b[j++]! });
    else out.push({ kind: '-', text: a[i++]! });
  }
  return out;
}

/** Warning signs of the new version that the installed one did not have (same rule and same line text). */
export function newRisks(before: string, after: string, file?: string): Risk[] {
  // Another file than the SKILL.md has no frontmatter: no program to look for on this machine.
  const scan = (text: string) => (file === undefined ? scanRisks(text) : scanRisks(text, () => true));
  const known = new Set(scan(before).map((r) => `${r.rule}\n${r.excerpt}`));
  return scan(after).filter((r) => !known.has(`${r.rule}\n${r.excerpt}`)).map((r) => (file === undefined ? r : { ...r, file }));
}

/** What an update does to one of the skill's other files. */
export interface FileChange {
  /** Relative to the skill folder. */
  path: string;
  status: 'added' | 'changed' | 'removed';
  added: number;
  removed: number;
  lines: DiffLine[];
}

export interface UpdateDiff {
  /** The SKILL.md, line by line; `added` and `removed` count its lines. */
  lines: DiffLine[];
  added: number;
  removed: number;
  /** The other text files the update adds, changes or removes. */
  files: FileChange[];
  /** The warning signs the new version brings, in the SKILL.md and in those files. */
  risks: Risk[];
}

type Target = Pick<Skill, 'source' | 'name' | 'path'>;
const count = (lines: DiffLine[], kind: '+' | '-') => lines.filter((l) => l.kind === kind).length;
const whole = (text: string, kind: '+' | '-'): DiffLine[] => text.split('\n').map((t) => ({ kind, text: t }));

/** The text files of an installed skill folder, relative paths with `/`, the SKILL.md left out. */
function localTextFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== 'node_modules') walk(join(dir, e.name), `${rel}/`);
      } else if (e.isFile() && isTextFile(rel) && !/^SKILL\.md$/i.test(rel)) out.push(rel);
    }
  };
  try {
    walk(root, '');
  } catch {
    // An unreadable subfolder: what was listed is still compared.
  }
  return out;
}

/** The other files of the folder, the installed copy against the repository's. */
function fileChanges(root: string, remote: SkillFiles): { files: FileChange[]; risks: Risk[] } {
  const files: FileChange[] = [];
  const risks: Risk[] = [];
  for (const f of remote.files) {
    if (f.path.split('/').some((p) => p === '..' || p === '')) continue;
    let before: string | undefined;
    try {
      before = stripControls(readFileSync(join(root, f.path), 'utf8'));
    } catch {
      before = undefined;
    }
    if (before === f.text) continue;
    const lines = before === undefined ? whole(f.text, '+') : lineDiff(before, f.text);
    files.push({ path: f.path, status: before === undefined ? 'added' : 'changed', added: count(lines, '+'), removed: count(lines, '-'), lines });
    risks.push(...newRisks(before ?? '', f.text, f.path));
  }
  // A file the repository no longer has. One it still has but that was not read is unknown, not removed.
  const there = new Set([...remote.files.map((f) => f.path), ...remote.skipped]);
  for (const path of localTextFiles(root)) {
    if (there.has(path)) continue;
    const lines = whole(stripControls(readFileSync(join(root, path), 'utf8')), '-');
    files.push({ path, status: 'removed', added: 0, removed: lines.length, lines });
  }
  if (remote.skipped.length) risks.push(unaudited(remote.skipped));
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), risks };
}

/**
 * What an update changes in a skill: its SKILL.md and the other text files of its
 * folder, the installed copy against the repository's. A script can change while the
 * SKILL.md stays the same. With a `read` of its own (tests), no other file is read
 * unless `readFiles` is given too; files that cannot be read are reported as not audited.
 */
export async function updateDiff(
  skill: Target,
  installed?: InstalledSkill[],
  read: (s: Target) => Promise<string> = fetchSkillMarkdown,
  readFiles: ((s: Target) => Promise<SkillFiles>) | undefined = read === fetchSkillMarkdown ? fetchSkillFiles : undefined,
): Promise<UpdateDiff> {
  const all = installed ?? (await listInstalled('global'));
  const local = all.find((s) => s.source?.toLowerCase() === skill.source.toLowerCase() && s.name.toLowerCase() === skill.name.toLowerCase() && s.path);
  if (!local) throw new Error(`${skill.source}@${skill.name} is not installed${installed ? '' : ' globally'}`);
  const before = stripControls(readFileSync(join(local.path!, 'SKILL.md'), 'utf8'));
  const after = await read(skill);
  const lines = lineDiff(before, after);
  const risks = newRisks(before, after);
  let files: FileChange[] = [];
  // Without the folder's path in the repository its files cannot be listed: only the SKILL.md is compared.
  if (readFiles && skill.path !== undefined) {
    try {
      const other = fileChanges(local.path!, await readFiles(skill));
      files = other.files;
      risks.push(...other.risks);
    } catch (err) {
      risks.push(unaudited([`other files (${err instanceof Error ? err.message : String(err)})`]));
    }
  }
  return { lines, added: count(lines, '+'), removed: count(lines, '-'), files, risks: sortRisks(risks) };
}

const MARK = { added: '+', changed: '~', removed: '-' } as const;

/** One line per changed file: `~ scripts/run.sh  +3 −1`. */
export const fileSummary = (f: FileChange): string => `${MARK[f.status]} ${f.path}  +${f.added} −${f.removed}`;

/** The whole update as text: the SKILL.md's changed lines, then each other file under its summary line. */
export function diffReport(diff: UpdateDiff, context = 2): string {
  return [diffText(diff.lines, context), ...diff.files.flatMap((f) => ['', `=== ${fileSummary(f)}`, diffText(f.lines, context)])].join('\n');
}

/** Changed lines with a few lines of context around them; long unchanged stretches become `…`. */
export function diffText(lines: DiffLine[], context = 2): string {
  const near = lines.map((_, i) => lines.slice(Math.max(0, i - context), i + context + 1).some((l) => l.kind !== ' '));
  const out: string[] = [];
  lines.forEach((l, i) => {
    if (near[i]) out.push(`${l.kind} ${l.text}`);
    else if (out.at(-1) !== '  …') out.push('  …');
  });
  return out.join('\n');
}
