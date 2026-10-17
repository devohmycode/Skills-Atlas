import pLimit from 'p-limit';
import { z } from 'zod';
import type { RawSkill } from '../../types.js';
import { fetchJson } from '../http.js';
import { cleanDescription, isValidSource, parseGitHubUrl, skillDir } from '../normalize.js';

const BASE = 'https://claude-plugins.dev/api/skills';
const PAGE_SIZE = 100;

const Entry = z.object({
  name: z.string(),
  sourceUrl: z.string().nullish(),
  description: z.string().nullish(),
  stars: z.number().nullish(),
  installs: z.number().nullish(),
  metadata: z
    .object({
      repoOwner: z.string().nullish(),
      repoName: z.string().nullish(),
      directoryPath: z.string().nullish(),
    })
    .nullish(),
});
const Page = z.object({ skills: z.array(z.unknown()), total: z.number() });

export function mapEntry(value: unknown): RawSkill | undefined {
  const parsed = Entry.safeParse(value);
  if (!parsed.success) return undefined;
  const e = parsed.data;
  const meta = e.metadata;
  let source = meta?.repoOwner && meta.repoName ? `${meta.repoOwner}/${meta.repoName}` : undefined;
  let path = meta?.directoryPath ?? undefined;
  if (!source && e.sourceUrl) {
    const gh = parseGitHubUrl(e.sourceUrl);
    source = gh?.source;
    path ??= gh?.path;
  }
  if (!source || !isValidSource(source)) return undefined;
  return {
    origin: 'claude-plugins.dev',
    name: e.name.trim(),
    source,
    // An empty directoryPath says nothing; one that names the SKILL.md gives its directory.
    path: path ? skillDir(path) : undefined,
    description: cleanDescription(e.description),
    installs: e.installs ?? undefined,
    stars: e.stars ?? undefined,
  };
}

export async function fetchClaudePluginsDev(log: (msg: string) => void = () => {}): Promise<RawSkill[]> {
  const first = Page.parse(await fetchJson(`${BASE}?limit=${PAGE_SIZE}&offset=0`));
  const offsets: number[] = [];
  for (let o = PAGE_SIZE; o < first.total; o += PAGE_SIZE) offsets.push(o);
  const limit = pLimit(4);
  let done = 1;
  const pages = await Promise.all(
    offsets.map((offset) =>
      limit(async () => {
        const page = Page.parse(await fetchJson(`${BASE}?limit=${PAGE_SIZE}&offset=${offset}`));
        if (++done % 50 === 0) log(`claude-plugins.dev: ${done}/${offsets.length + 1} pages`);
        return page.skills;
      }),
    ),
  );
  const out: RawSkill[] = [];
  for (const entry of [first.skills, ...pages].flat()) {
    const skill = mapEntry(entry);
    if (skill) out.push(skill);
  }
  return out;
}
