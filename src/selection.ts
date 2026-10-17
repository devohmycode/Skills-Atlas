import { z } from 'zod';
import { parseSkillId } from './install/plan.js';
import type { InstalledSkill } from './install/run.js';

/** What `export` writes and `import` reads: skill ids, so that `skills add` can install them anywhere. */
export interface Selection {
  skillsAtlas: 1;
  skills: string[];
}

/**
 * The installed skills as a selection, each once whatever its scopes. Skills
 * without a GitHub source (home-made, or installed from a local path) cannot be
 * installed elsewhere: they are returned apart.
 */
export function toSelection(installed: InstalledSkill[]): { selection: Selection; skipped: string[] } {
  const ids = new Map<string, string>();
  const skipped = new Set<string>();
  for (const s of installed) {
    if (s.source) ids.set(`${s.source}@${s.name}`.toLowerCase(), `${s.source}@${s.name}`);
    else skipped.add(s.name);
  }
  return { selection: { skillsAtlas: 1, skills: [...ids.values()].sort() }, skipped: [...skipped].sort() };
}

const File = z.object({ skillsAtlas: z.literal(1), skills: z.array(z.string()) });

/** The ids of a selection file, checked: a file from elsewhere is untrusted input to `npx skills add`. */
export function parseSelection(text: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('not a JSON file');
  }
  const file = File.safeParse(raw);
  if (!file.success) throw new Error('not a skills-atlas selection ({ "skillsAtlas": 1, "skills": [...] })');
  for (const id of file.data.skills) checkSkillName(parseSkillId(id).name, id);
  return [...new Set(file.data.skills)];
}

/**
 * Throws on a skill name that is not safe to pass to `npx skills`, whoever wrote it (a file, a model):
 * a leading dash would reach it as a flag, and a quote or control character could break the quoting
 * of Windows's fallback shell. Real names have neither.
 */
export function checkSkillName(name: string, context = name): void {
  if (name.startsWith('-') || /["\u0000-\u001f\u007f]/.test(name) || name.length > 200) throw new Error(`invalid skill name in "${context}"`);
}
