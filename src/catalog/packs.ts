import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import bundled from '../../data/packs.json' with { type: 'json' };
import { configPath } from '../config.js';
import { parseSkillId } from '../install/plan.js';
import { checkSkillName } from '../selection.js';
import type { Catalog, Skill } from '../types.js';

/** A curated set of skills for one kind of work, installed as a block. */
export interface Pack {
  id: string;
  name: string;
  description: string;
  skills: string[];
}

const PackInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().min(1),
  skills: z.array(z.string()).min(1).max(100),
});
const Packs = z.array(PackInput);

/** Theme id of a pack in the tree and on the web page. */
export const packTheme = (id: string) => `pack:${id}`;

/** Availability in this snapshot, without declaring an absent skill uninstallable. */
export function packStatus(pack: Pack, skills: Catalog['skills']) {
  const known = new Set(skills.map((s) => s.id.toLowerCase()));
  const ids = [...new Map(pack.skills.map((id) => [id.toLowerCase(), id])).values()];
  const missing = ids.filter((id) => !known.has(id.toLowerCase()));
  return { available: ids.length - missing.length, total: ids.length, missing };
}

function parsePacks(raw: unknown): Pack[] {
  const result = Packs.safeParse(raw);
  if (!result.success) throw new Error(`Invalid packs: ${result.error.message}`);
  // A personal file is input to `npx skills add`: its ids are checked like a selection file's.
  for (const p of result.data) for (const id of p.skills) checkSkillName(parseSkillId(id).name, id);
  return result.data;
}

/** A personal list replaces the shipped packs; [] hides them. */
export function readPacks(path = join(dirname(configPath()), 'packs.json')): Pack[] {
  try {
    return parsePacks(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parsePacks(bundled);
    throw new Error(`Could not read packs from ${path}`, { cause: error });
  }
}

/** Invalid requests and duplicate ids are distinct from filesystem/configuration failures. */
export class PackSaveError extends Error {
  constructor(readonly status: 400 | 409, message: string) { super(message); }
}

/** Add a personal pack without losing defaults, existing packs, or an invalid file. */
export function savePack(raw: unknown, catalogSkills: Skill[], path = join(dirname(configPath()), 'packs.json')): Pack {
  const parsed = PackInput.strict().safeParse(raw);
  if (!parsed.success) throw new PackSaveError(400, 'invalid pack');
  const pack = parsed.data;
  try { parsePacks([pack]); }
  catch { throw new PackSaveError(400, 'invalid pack skill ids'); }
  const known = new Set(catalogSkills.map((s) => s.id));
  if (pack.skills.some((id) => !known.has(id))) throw new PackSaveError(400, 'unknown pack skills');
  if (new Set(pack.skills.map((id) => id.toLowerCase())).size !== pack.skills.length) throw new PackSaveError(400, 'duplicate pack skills');
  const existing = readPacks(path);
  if (existing.some((p) => p.id === pack.id)) throw new PackSaveError(409, 'pack id already exists');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + '.' + randomBytes(12).toString('hex') + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify([...existing, pack], null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  return pack;
}

/**
 * One theme per pack, after Recommended and Trending, holding the pack's
 * skills: ticking the theme ticks the pack. Skills the catalog does not know
 * (an alternative catalog) are left out of the theme, not invented.
 */
export function withPacks(catalog: Catalog, packs: Pack[] = readPacks()): Catalog {
  if (!packs.length) return catalog;
  const members = new Map<string, string[]>();
  for (const p of packs) for (const id of p.skills) members.set(id.toLowerCase(), [...(members.get(id.toLowerCase()) ?? []), packTheme(p.id)]);
  const skills = catalog.skills.map((s) => {
    const extra = members.get(s.id.toLowerCase());
    return extra ? { ...s, themes: [...new Set([...s.themes, ...extra])] } : s;
  });
  const byTheme = { ...catalog.stats.byTheme };
  for (const p of packs) byTheme[packTheme(p.id)] = skills.filter((s) => s.themes.includes(packTheme(p.id))).length;
  const packThemes = packs.map((p) => ({ id: packTheme(p.id), label: `📦 ${p.name}`, description: p.description, pack: packStatus(p, catalog.skills) }));
  const others = catalog.themes.filter((th) => !th.id.startsWith('pack:'));
  const after = Math.max(others.findIndex((th) => th.id === 'trending'), others.findIndex((th) => th.id === 'recommended')) + 1;
  return { ...catalog, skills, themes: [...others.slice(0, after), ...packThemes, ...others.slice(after)], stats: { ...catalog.stats, byTheme } };
}
