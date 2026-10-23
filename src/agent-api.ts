import { AGENTS } from './agents.js';
import { querySkills } from './catalog/query.js';
import { auditSkills } from './audit.js';
import { fetchSkillFiles, fetchSkillMarkdown, githubUrl } from './github.js';
import { parseSkillId } from './install/plan.js';
import { listInstalled } from './install/run.js';
import { findUpdates, type UpdateCheck } from './install/updates.js';
import type { Risk } from './risks.js';
import type { Catalog, Scope, Skill } from './types.js';

/**
 * What an agent (the CLI's non-interactive commands, the MCP server) can ask
 * of skills-atlas, as plain data: search, read a SKILL.md, list what is
 * installed or outdated.
 */

/** A skill as an agent needs it to choose: no internal fields. */
export interface SkillSummary {
  id: string;
  name: string;
  source: string;
  description?: string;
  installs?: number;
  official?: boolean;
  recommended?: boolean;
  themes: string[];
  url?: string;
  requires?: { bins?: string[]; compatibility?: string };
  updated_at?: string;
  license?: string;
  archived?: boolean;
  last_push?: string;
}

export function summarize(s: Skill): SkillSummary {
  return {
    id: s.id, name: s.name, source: s.source, description: s.description, installs: s.installs,
    official: s.official || undefined, recommended: s.recommendation ? true : undefined, themes: s.themes, url: githubUrl(s),
    requires: s.requires, updated_at: s.updatedAt,
    license: s.repo?.license, archived: s.repo?.archived, last_push: s.repo?.pushedAt,
  };
}

/** Agent ids from the display names the installed-skill scan reports; unknown names are dropped. */
export function agentIds(names: string[]): string[] {
  return [...new Set(names.map((n) => AGENTS.find((a) => a.displayName === n)?.id).filter((id): id is string => !!id))];
}

/** Search matches ranked by relevance, with popularity breaking ties. */
export function searchSkills(catalog: Catalog, opts: { query?: string; theme?: string; official?: boolean; limit?: number } = {}): SkillSummary[] {
  const found = querySkills(catalog, { search: opts.query, themes: opts.theme ? [opts.theme] : undefined, official: opts.official });
  return found.slice(0, opts.limit ?? 20).map(summarize);
}

/** The catalog entry for an id (any case), or a bare one built from the id for a skill the catalog does not know. */
export function findSkill(catalog: Catalog, id: string): Skill {
  const known = catalog.skills.find((s) => s.id.toLowerCase() === id.toLowerCase());
  if (known) return known;
  const { source, name } = parseSkillId(id);
  return { id, name, source, labels: [], origins: [], themes: [] };
}

/** A skill's SKILL.md, from its GitHub repository (escape sequences removed), and the warning signs of its folder. */
export async function showSkill(catalog: Catalog, id: string): Promise<{ skill: SkillSummary; markdown: string; risks: Risk[] }> {
  const skill = findSkill(catalog, id);
  const markdown = await fetchSkillMarkdown(skill);
  // The audit's view: the other files of the folder too, the SKILL.md read once.
  const [audit] = await auditSkills([skill], async () => markdown, fetchSkillFiles);
  return { skill: summarize(skill), markdown, risks: audit!.risks };
}

/** An installed skill, with the agent ids an install command needs. */
export interface InstalledSummary {
  id: string;
  name: string;
  source?: string;
  scope: Scope;
  agents: string[];
}

export async function installedSkills(scopes: Scope[]): Promise<InstalledSummary[]> {
  const found = (await Promise.all(scopes.map((sc) => listInstalled(sc)))).flat();
  return found.map((s) => ({ id: `${s.source ?? 'local'}@${s.name}`, name: s.name, source: s.source, scope: s.scope, agents: agentIds(s.agents) }));
}

/**
 * The installed skills each agent sees, agents by name, skills by name. A skill
 * in the shared `.agents/skills` directory shows under every agent that reads it.
 */
export function skillsByAgent(installed: InstalledSummary[]): { agent: string; name: string; skills: InstalledSummary[] }[] {
  const byAgent = new Map<string, InstalledSummary[]>();
  for (const s of installed) for (const a of s.agents) byAgent.set(a, [...(byAgent.get(a) ?? []), s]);
  return [...byAgent]
    .map(([agent, skills]) => ({ agent, name: AGENTS.find((a) => a.id === agent)?.displayName ?? agent, skills: skills.sort((x, y) => x.name.localeCompare(y.name)) }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Global skills with a newer version on GitHub. Updating one is installing it
 * again: `skills-atlas install <id> -g -a <its agents> -y`. `unchecked` lists what
 * could not be checked: the check is complete only when it is empty.
 */
export async function outdatedSkills(): Promise<{ skills: InstalledSummary[]; unchecked: UpdateCheck['unchecked'] }> {
  const [found, installed] = await Promise.all([findUpdates(), installedSkills(['global'])]);
  return { skills: installed.filter((s) => s.source && found.outdated.has(`${s.source}@${s.name}`.toLowerCase())), unchecked: found.unchecked };
}
