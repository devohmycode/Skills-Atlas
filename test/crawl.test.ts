import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('a crawl that finds no skill fails and leaves the previous snapshot byte for byte', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'atlas-crawl-'));
  const out = join(cwd, 'catalog.json.gz');
  const previous = Buffer.from('previous snapshot');
  writeFileSync(out, previous);
  // claude-plugins.dev answers an empty list; every other source is gone.
  const preload = join(cwd, 'fetch.mjs');
  writeFileSync(preload, `globalThis.fetch = async (url) => String(url).startsWith('https://claude-plugins.dev/api/skills')
    ? Response.json({ skills: [], total: 0 }) : new Response('gone', { status: 404 });`);
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  try {
    const res = spawnSync(process.execPath, ['--import', tsx, '--import', pathToFileURL(preload).href, fileURLToPath(new URL('../scripts/crawl.ts', import.meta.url)), '--enrich', '0', '--requires', '0', '--out', out], {
      cwd, encoding: 'utf8', env: { ...process.env, GITHUB_TOKEN: 'test' },
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('the crawl found no skill');
    expect(readFileSync(out)).toEqual(previous);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}, 60_000);
