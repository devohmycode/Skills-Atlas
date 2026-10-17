import { openBrowser } from './browser.js';
import { guessPaths } from './catalog/enrich.js';
import { fetchText } from './catalog/http.js';
import { isValidSource, skillDir } from './catalog/normalize.js';
import type { Skill } from './types.js';

/** Local skills do not have a repository to open. */
export function githubUrl(skill: Pick<Skill, 'source'>): string | undefined {
  if (!isValidSource(skill.source) || skill.source.split('/').some((part) => part === '.' || part === '..')) return undefined;
  return `https://github.com/${skill.source}`;
}

export function openGitHub(skill: Pick<Skill, 'source'>): void {
  const url = githubUrl(skill);
  if (url) openBrowser(url);
}

/**
 * A skill's SKILL.md from its repository, at its known path or the usual ones.
 * The text is untrusted: control characters and escape sequences are removed
 * so that it cannot drive the terminal it is shown in.
 */
export async function fetchSkillMarkdown(skill: Pick<Skill, 'source' | 'name' | 'path'>): Promise<string> {
  if (!githubUrl(skill)) throw new Error('no GitHub repository');
  let lastError: unknown = new Error('SKILL.md not found');
  // skillDir: snapshots older than its fix may hold the SKILL.md's own path.
  for (const dir of skill.path !== undefined ? [skillDir(skill.path)] : guessPaths(skill.name)) {
    try {
      const url = `https://raw.githubusercontent.com/${skill.source}/HEAD/${dir ? `${dir}/` : ''}SKILL.md`;
      return stripControls(await fetchText(url, { retries: 1, timeoutMs: 15_000 }));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** Keeps printable text, line breaks and tabs (as spaces); drops ANSI/OSC sequences and other control characters. */
export function stripControls(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');
}
