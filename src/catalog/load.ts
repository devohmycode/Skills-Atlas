import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { z } from 'zod';
import { parseSkillId } from '../install/plan.js';
import type { Catalog } from '../types.js';

// The shape of `Catalog` (src/types.ts). Unknown fields are kept, so that newer snapshots still load.
const str = z.string();
const num = z.number();
const Skill = z.looseObject({
  id: str, name: str, source: str, labels: z.array(str), origins: z.array(z.enum(['claude-plugins.dev', 'smithery', 'skills.sh'])), themes: z.array(str),
  path: str.optional(), description: str.optional(), installs: num.optional(), stars: num.optional(), rank: num.optional(), growth: num.optional(),
  requires: z.looseObject({ bins: z.array(str).optional(), compatibility: str.optional() }).optional(),
  updatedAt: str.optional(), growthSuspect: num.optional(),
  repo: z.looseObject({ license: str.optional(), archived: z.boolean().optional(), pushedAt: str.optional() }).optional(),
  official: z.boolean().optional(),
  recommendation: z.looseObject({ repository: str, reason: str, order: num }).optional(),
});

/** An entry `install` would refuse (a name read as a flag, a malformed source) or whose id is not its source@name. */
function installable(s: { id: string; source: string; name: string }): boolean {
  try {
    const { source, name } = parseSkillId(s.id);
    return source === s.source && name === s.name;
  } catch {
    return false;
  }
}
const Theme = z.looseObject({
  id: str, label: str, description: str.optional(),
  pack: z.looseObject({ available: num, total: num, missing: z.array(str) }).optional(),
});
const CatalogSchema = z.looseObject({
  version: z.literal(1),
  generatedAt: str.min(1),
  themes: z.array(Theme),
  skills: z.array(Skill),
  stats: z.looseObject({
    sources: z.record(str, z.looseObject({ status: z.enum(['ok', 'error']), count: num, error: str.optional() })).optional(),
    raw: z.record(str, num),
    merged: num,
    official: num.optional(),
    growthSince: str.optional(),
    byTheme: z.record(str, num),
  }),
});

/** Default snapshot: `data/catalog.json.gz`, found next to `dist/` or `src/catalog/`. */
export function defaultCatalogPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, 'data', 'catalog.json.gz');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return join(process.cwd(), 'data', 'catalog.json.gz');
}

export function decodeCatalog(buf: Buffer): Catalog {
  // gzip magic number: 1f 8b
  const text = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  const parsed = CatalogSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`invalid catalog: ${issues.join('; ')}${parsed.error.issues.length > 3 ? ` (+${parsed.error.issues.length - 3} more)` : ''}`);
  }
  // Entries that could never install are left out rather than failing the whole catalog.
  return { ...parsed.data, skills: parsed.data.skills.filter(installable) } as Catalog;
}

/** Loads the catalog from a local path (`.json` or `.json.gz`) or an http(s) URL. */
export async function loadCatalog(location = defaultCatalogPath()): Promise<Catalog> {
  if (/^https?:\/\//.test(location)) {
    const res = await fetch(location, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${location}`);
    return decodeCatalog(Buffer.from(await res.arrayBuffer()));
  }
  if (!existsSync(location)) {
    throw new Error(`catalog not found at ${location} — run \`npm run crawl\` or pass --catalog <path|url>`);
  }
  return decodeCatalog(await readFile(location));
}

export async function saveCatalog(catalog: Catalog, path: string): Promise<number> {
  const buf = gzipSync(JSON.stringify(catalog), { level: 9 });
  await writeFile(path, buf);
  return buf.length;
}
