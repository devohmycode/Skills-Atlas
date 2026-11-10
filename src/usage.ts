import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { InstalledSkill } from './install/run.js';
import { frontmatterName } from './install/scan.js';

/**
 * Which installed skills an agent actually used, read from its session transcripts on
 * this machine. Only Claude Code keeps transcripts this can read (`~/.claude/projects`,
 * one JSON line per message): a skill counts as used when the agent called the Skill
 * tool with its name, when the user typed it as a slash command, or when the agent read
 * its SKILL.md. Nothing leaves the machine, and nothing is kept of what is read.
 */

/** The agent whose transcripts are read, as the scan of installed skills names it. */
export const USAGE_AGENT = 'Claude Code';

/** Where Claude Code keeps its transcripts: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export const transcriptsDir = (env: NodeJS.ProcessEnv = process.env): string => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');

export interface SkillUse {
  count: number;
  /** Day of the last use (YYYY-MM-DD). */
  last: string;
}

export interface UsageScan {
  /** Transcripts read: those changed since `since`. */
  files: number;
  /** Transcripts left unread: too large, or unreadable. */
  skipped: number;
  /** Uses by skill name, lower case. */
  uses: Map<string, SkillUse>;
}

/** Transcripts above this size are not read: one buffer per file. */
const MAX_BYTES = 1024 * 1024 * 1024;
/** What a line that may hold a use contains; the other lines are never parsed. */
const MARKERS = ['"name":"Skill"', '<command-name>', 'SKILL.md'].map((m) => Buffer.from(m));
/** A line longer than this is a tool result or a request copy, not a call. */
const MAX_LINE = 256 * 1024;

/** `plugin:skill`, `apps/web:skill` and `/skill` all name `skill`. */
const skillKey = (name: string): string => name.trim().replace(/^\//, '').split(':').pop()!.toLowerCase();

/** The skill names one transcript line uses. */
export function usesInLine(line: string): string[] {
  let entry: { type?: string; message?: { content?: unknown } };
  try {
    entry = JSON.parse(line) as typeof entry;
  } catch {
    return [];
  }
  const content = entry.message?.content;
  const out: string[] = [];
  const command = (text: string) => {
    for (const m of text.matchAll(/<command-name>\/?([^<\s]+)<\/command-name>/g)) out.push(skillKey(m[1]!));
  };
  if (entry.type === 'user' && typeof content === 'string') command(content);
  if (!Array.isArray(content)) return out;
  for (const item of content as { type?: string; name?: string; text?: string; input?: { skill?: unknown; file_path?: unknown } }[]) {
    if (entry.type === 'user' && item.type === 'text' && typeof item.text === 'string') command(item.text);
    if (entry.type !== 'assistant' || item.type !== 'tool_use') continue;
    if (item.name === 'Skill' && typeof item.input?.skill === 'string') out.push(skillKey(item.input.skill));
    // Reading a skill's SKILL.md is using it too: `…/skills/<name>/SKILL.md`.
    const read = item.name === 'Read' && typeof item.input?.file_path === 'string' ? /([^\\/]+)[\\/]SKILL\.md$/i.exec(item.input.file_path) : null;
    if (read) out.push(read[1]!.toLowerCase());
  }
  return out;
}

/** The lines of a transcript that hold a marker, without decoding the others. */
function* candidateLines(buf: Buffer): Generator<string> {
  let from = 0;
  // Each marker's next position is kept: searching again from every line would read the file once per hit.
  const next = MARKERS.map((m) => buf.indexOf(m));
  while (from < buf.length) {
    let hit = -1;
    MARKERS.forEach((m, k) => {
      if (next[k]! >= 0 && next[k]! < from) next[k] = buf.indexOf(m, from);
      if (next[k]! >= 0 && (hit < 0 || next[k]! < hit)) hit = next[k]!;
    });
    if (hit < 0) return;
    const start = buf.lastIndexOf(10, hit) + 1;
    let end = buf.indexOf(10, hit);
    if (end < 0) end = buf.length;
    if (end - start <= MAX_LINE) yield buf.toString('utf8', start, end);
    from = end + 1;
  }
}

function transcripts(dir: string, since: number, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) transcripts(path, since, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

/** Reads the transcripts changed since `since` and counts the uses dated since then. */
export function scanUsage(dir: string, since: Date): UsageScan {
  const scan: UsageScan = { files: 0, skipped: 0, uses: new Map() };
  const from = since.toISOString();
  for (const path of transcripts(dir, since.getTime())) {
    let buf: Buffer;
    try {
      const stat = statSync(path);
      if (stat.mtimeMs < since.getTime()) continue;
      if (stat.size > MAX_BYTES) {
        scan.skipped++;
        continue;
      }
      buf = readFileSync(path);
    } catch {
      scan.skipped++;
      continue;
    }
    scan.files++;
    for (const line of candidateLines(buf)) {
      // The timestamp is read from the text: parsing waits until the line is known to be in the window.
      const at = /"timestamp":"([^"]+)"/.exec(line)?.[1];
      if (!at || at < from) continue;
      for (const name of usesInLine(line)) {
        const use = scan.uses.get(name) ?? { count: 0, last: '' };
        use.count++;
        if (at.slice(0, 10) > use.last) use.last = at.slice(0, 10);
        scan.uses.set(name, use);
      }
    }
  }
  return scan;
}

export interface UsageReport {
  /** Seen by the agent for the whole window and never used in it. */
  unused: InstalledSkill[];
  /** Used in the window, most used first. */
  used: (InstalledSkill & SkillUse)[];
  /** Installed during the window and not used yet: too early to tell. */
  recent: InstalledSkill[];
  /** Not installed for the agent whose transcripts are read: nothing is known. */
  unknown: InstalledSkill[];
}

/** When a skill folder appeared; a reinstall (an update) starts it again. */
function installedAt(path: string): number | undefined {
  try {
    const stat = statSync(path);
    return stat.birthtimeMs || stat.mtimeMs;
  } catch {
    return undefined;
  }
}

/** The names a skill can be called by: the one the scan gives, its folder's, and its SKILL.md's. */
function namesOf(s: InstalledSkill): string[] {
  const names = [s.name];
  if (!s.path) return names;
  names.push(basename(s.path));
  try {
    const own = frontmatterName(readFileSync(join(s.path, 'SKILL.md'), 'utf8'));
    if (own) names.push(own);
  } catch {
    // An unreadable SKILL.md: the other names still count.
  }
  return names;
}

/** Sorts the installed skills by what the transcripts say of them. */
export function usageReport(
  installed: InstalledSkill[],
  scan: UsageScan,
  since: Date,
  born: (path: string) => number | undefined = installedAt,
  names: (s: InstalledSkill) => string[] = namesOf,
): UsageReport {
  const report: UsageReport = { unused: [], used: [], recent: [], unknown: [] };
  for (const s of installed) {
    const found = names(s).map((n) => scan.uses.get(n.toLowerCase())).filter((u) => u !== undefined);
    const use = found.length ? { count: found.reduce((n, u) => Math.max(n, u.count), 0), last: found.map((u) => u.last).sort().at(-1)! } : undefined;
    if (!s.agents.includes(USAGE_AGENT)) report.unknown.push(s);
    else if (use) report.used.push({ ...s, ...use });
    else if (((s.path ? born(s.path) : undefined) ?? 0) > since.getTime()) report.recent.push(s);
    else report.unused.push(s);
  }
  report.used.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return report;
}
