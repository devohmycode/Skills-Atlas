/**
 * Rebuilds data/catalog.json.gz from every public source.
 *
 *   npm run crawl                      full crawl
 *   npm run crawl -- --max-owners 50   also fetch skills.sh install counts for the top 50 owners (slow: rate limited)
 *   npm run crawl -- --enrich 0         skip description enrichment (default 5000)
 *   npm run crawl -- --requires 0       skip reading prerequisites (default 3000 skills, 1000 dated)
 */
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildCatalog } from '../src/catalog/build.js';
import { loadCatalog, saveCatalog } from '../src/catalog/load.js';
import { enrichRequirements } from '../src/catalog/requirements.js';
import { enrichRepositories } from '../src/catalog/repos.js';
import { markGrowth } from '../src/catalog/trending.js';

const args = process.argv.slice(2);
const maxOwnersIdx = args.indexOf('--max-owners');
const maxSkillsShOwners = maxOwnersIdx >= 0 ? Number(args[maxOwnersIdx + 1]) : undefined;
const enrichIdx = args.indexOf('--enrich');
const enrich = enrichIdx >= 0 ? Number(args[enrichIdx + 1]) : 5000;
const requiresIdx = args.indexOf('--requires');
const requires = requiresIdx >= 0 ? Number(args[requiresIdx + 1]) : 3000;
const outIdx = args.indexOf('--out');
const out = outIdx >= 0 ? args[outIdx + 1]! : join('data', 'catalog.json.gz');

/** GITHUB_TOKEN (set in Actions), else the GitHub CLI's token when logged in. */
function githubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const started = Date.now();
const log = (msg: string) => console.error(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${msg}`);

const token = githubToken();
const catalog = await buildCatalog({ maxSkillsShOwners, enrich, githubToken: token, log });
// The snapshot about to be replaced is the previous crawl's: growth is measured against it.
const previous = await loadCatalog(out).catch(() => undefined);
catalog.stats.growthSince = markGrowth(catalog.skills, previous);
log(`growth: ${catalog.skills.filter((s) => s.growth).length} skills gained installs since ${catalog.stats.growthSince ?? 'nothing (no previous snapshot)'}`);
if (requires) {
  const { read, dated } = await enrichRequirements(catalog.skills, { max: requires, maxDates: Math.min(requires, 1000), githubToken: token, previous, log });
  log(`requirements: ${read} SKILL.md read, ${dated} dated, ${catalog.skills.filter((s) => s.requires).length} skills state requirements`);
}
log(`repositories: ${await enrichRepositories(catalog.skills, { githubToken: token, max: 5000, previous, log })} looked up on GitHub`);
await mkdir('data', { recursive: true });
const bytes = await saveCatalog(catalog, out);

const rawTotal = Object.values(catalog.stats.raw).reduce((a, b) => a + b, 0);
console.log(`\n${out}: ${catalog.stats.merged} skills (${(bytes / 1024 / 1024).toFixed(1)} MB gzip)`);
console.log(`raw entries: ${JSON.stringify(catalog.stats.raw)} — ${rawTotal} → ${catalog.stats.merged} after dedupe`);
for (const theme of catalog.themes) {
  const n = catalog.stats.byTheme[theme.id] ?? 0;
  console.log(`  ${theme.label.padEnd(32)} ${String(n).padStart(6)}  ${((n / catalog.stats.merged) * 100).toFixed(1)}%`);
}
