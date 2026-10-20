import { z } from 'zod';
import type { Catalog, Skill } from '../types.js';
import { compareSkills } from './dedupe.js';
import { HttpError } from './http.js';

export interface RepositoryOptions {
  githubToken?: string;
  /** How many repositories to look up, those of the most installed skills first. */
  max: number;
  previous?: Catalog;
  log?: (msg: string) => void;
  /** Replaced in tests. */
  fetch?: typeof fetch;
}

/** Repositories per GraphQL query: one point of the 5,000-an-hour budget each. */
const BATCH = 50;

const Repo = z.object({
  isArchived: z.boolean(),
  pushedAt: z.string().nullable(),
  stargazerCount: z.number(),
  licenseInfo: z.object({ spdxId: z.string().nullable() }).nullable(),
}).nullable();

/**
 * Records, per repository, its license, whether it is archived and when it was last
 * pushed to, with GitHub's GraphQL API (50 repositories a query). Copied onto each of its
 * skills as `repo`; stars fill in where the sources gave none. Repositories it does not
 * reach keep the previous snapshot's values. Mutates the skills.
 */
export async function enrichRepositories(skills: Skill[], opts: RepositoryOptions): Promise<number> {
  const log = opts.log ?? (() => {});
  const before = new Map(opts.previous?.skills.filter((s) => s.repo).map((s) => [s.source.toLowerCase(), s.repo!]));
  for (const s of skills) s.repo ??= before.get(s.source.toLowerCase());
  if (!opts.githubToken) return 0;
  const sources = [...new Set([...skills].sort(compareSkills).map((s) => s.source))]
    .filter((src) => /^[\w.-]+\/[\w.-]+$/.test(src)).slice(0, opts.max);
  const found = new Map<string, NonNullable<z.infer<typeof Repo>>>();
  for (let i = 0; i < sources.length; i += BATCH) {
    const batch = sources.slice(i, i + BATCH);
    const query = `{${batch.map((src, j) => {
      const [owner, name] = src.split('/');
      return `r${j}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { isArchived pushedAt stargazerCount licenseInfo { spdxId } }`;
    }).join(' ')}}`;
    try {
      const res = await (opts.fetch ?? fetch)('https://api.github.com/graphql', {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.githubToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 403 || res.status === 429) throw new HttpError('https://api.github.com/graphql', res.status);
      // A repository gone or renamed answers null with an error for its alias: the others still count.
      const data = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
      batch.forEach((src, j) => {
        const r = Repo.safeParse(data[`r${j}`]);
        if (r.success && r.data) found.set(src.toLowerCase(), r.data);
      });
    } catch (err) {
      if (err instanceof HttpError) {
        log(`repositories: GitHub rate limit reached after ${found.size}, stopping`);
        break;
      }
    }
  }
  for (const s of skills) {
    const r = found.get(s.source.toLowerCase());
    if (!r) continue;
    const license = r.licenseInfo?.spdxId && r.licenseInfo.spdxId !== 'NOASSERTION' ? r.licenseInfo.spdxId : undefined;
    s.repo = { ...(license ? { license } : {}), ...(r.isArchived ? { archived: true } : {}), ...(r.pushedAt ? { pushedAt: r.pushedAt.slice(0, 10) } : {}) };
    s.stars ??= r.stargazerCount || undefined;
  }
  return found.size;
}
