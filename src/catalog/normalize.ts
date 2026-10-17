/**
 * Parses a GitHub URL such as `https://github.com/o/r/tree/main/skills/x`
 * into its `owner/repo` source and the path inside the repo.
 */
export function parseGitHubUrl(url: string): { source: string; path?: string } | undefined {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)(?:\/(?:tree|blob)\/[^/]+\/?(.*))?/i.exec(
    url.trim(),
  );
  if (!m) return undefined;
  const owner = m[1]!;
  const repo = m[2]!.replace(/\.git$/i, '');
  // No tree/blob part: the path is unknown. A URL to the repository's root, or to its SKILL.md, is the root ('').
  return { source: `${owner}/${repo}`, path: m[3] === undefined ? undefined : skillDir(m[3]) };
}

/**
 * The skill's directory inside its repository, from a path that may name the
 * SKILL.md itself: `skills/x/SKILL.md` → `skills/x`, `SKILL.md` → `` (the root).
 */
export function skillDir(path: string): string {
  return path.replace(/\\/g, '/').replace(/(^|\/)SKILL\.md$/i, '').replace(/^\/+|\/+$/g, '');
}

/** Lower-cases and trims a skill name so that sources can be compared. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function isValidSource(source: string): boolean {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source);
}

// Windows-1252 code points of bytes 0x80–0x9F, the ones that differ from Latin-1.
const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/**
 * Repairs UTF-8 text that was decoded as Windows-1252/Latin-1 upstream
 * (`é£ä¹¦` → `飞书`). Text that does not round-trip cleanly is returned as is.
 */
export function fixMojibake(text: string): string {
  if (!/[Â-ô][\u0080-¿Œ-™]/.test(text)) return text;
  const bytes: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x100) bytes.push(cp);
    else if (CP1252[cp] !== undefined) bytes.push(CP1252[cp]);
    else return text;
  }
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
  return decoded.includes('�') ? text : decoded;
}

/** YAML block indicators left behind by sources with a naive frontmatter parser. */
const BROKEN = /^[>|][-+]?\d*$/;

/** Collapses whitespace, repairs encoding and bounds the length of a description. */
export function cleanDescription(text: string | null | undefined, max = 400): string | undefined {
  if (!text) return undefined;
  const flat = fixMojibake(text).replace(/\s+/g, ' ').trim();
  if (!flat || BROKEN.test(flat)) return undefined;
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Reads `description` from a SKILL.md frontmatter, including the folded (`>`)
 * and literal (`|`) block forms. Not a full YAML parser.
 */
export function frontmatterDescription(markdown: string): string | undefined {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
  if (!fm) return undefined;
  const lines = fm.split(/\r?\n/);
  const i = lines.findIndex((l) => /^description\s*:/.test(l));
  if (i < 0) return undefined;
  const inline = lines[i]!.replace(/^description\s*:\s*/, '').trim();
  if (inline && !BROKEN.test(inline)) {
    const unquoted = /^(["'])([\s\S]*)\1$/.exec(inline);
    return cleanDescription(unquoted ? unquoted[2]!.replace(/\\"/g, '"').replace(/''/g, "'") : inline);
  }
  const block: string[] = [];
  for (const line of lines.slice(i + 1)) {
    if (line.trim() && !/^\s/.test(line)) break;
    block.push(line.trim());
  }
  return cleanDescription(block.join(' '));
}
