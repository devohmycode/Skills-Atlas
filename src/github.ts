import { openBrowser } from './browser.js';
import { isValidSource } from './catalog/normalize.js';
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
