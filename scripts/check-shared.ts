/**
 * skills-atlas, mcp-atlas and plugins-atlas copy a few terminal primitives byte for byte
 * instead of sharing a package (the rest of their code has diverged too far for one).
 * This checks that the copies still match, so that a fix made in one reaches the others.
 *
 *   npm run check:shared              compare with each sibling's main branch on GitHub
 *   npm run check:shared -- --local   compare with sibling checkouts next to this one (../mcp-atlas…)
 *
 * Exits with 1 and names the files that differ.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** File under src/ → the sibling repositories that must hold the same bytes. */
export const SHARED: Record<string, string[]> = {
  'browser.ts': ['mcp-atlas', 'plugins-atlas'],
  'ui/mouse.ts': ['mcp-atlas', 'plugins-atlas'],
  'ui/palette.ts': ['mcp-atlas', 'plugins-atlas'],
  'ui/render.ts': ['mcp-atlas', 'plugins-atlas'],
  'ui/width.ts': ['mcp-atlas', 'plugins-atlas'],
  // plugins-atlas reads its strings from its own messages module, not i18n.
  'ui/ListSelect.tsx': ['mcp-atlas'],
};

const normalize = (text: string) => text.replace(/\r\n?/g, '\n');

export async function drift(read: (repo: string, file: string) => Promise<string>, own = (file: string) => readFile(join('src', file), 'utf8')) {
  const out: { file: string; repo: string; error?: string }[] = [];
  for (const [file, repos] of Object.entries(SHARED)) {
    const mine = normalize(await own(file));
    for (const repo of repos) {
      try {
        if (normalize(await read(repo, file)) !== mine) out.push({ file, repo });
      } catch (err) {
        out.push({ file, repo, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
}

const fromGitHub = async (repo: string, file: string) => {
  const res = await fetch(`https://raw.githubusercontent.com/devohmycode/${repo}/main/src/${file}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};
const fromSibling = (repo: string, file: string) => readFile(join('..', repo, 'src', file), 'utf8');

if (process.argv[1]?.endsWith('check-shared.ts')) {
  const local = process.argv.includes('--local');
  const found = await drift(local ? fromSibling : fromGitHub);
  for (const d of found) console.error(`${d.error ? 'unreadable' : 'differs   '}  src/${d.file}  ${d.repo}${d.error ? `: ${d.error}` : ''}`);
  const checked = Object.values(SHARED).reduce((n, r) => n + r.length, 0);
  console.log(found.length ? `${found.length} of ${checked} shared copies out of step` : `${checked} shared copies match (${local ? 'local checkouts' : 'GitHub main'})`);
  process.exitCode = found.length ? 1 : 0;
}
