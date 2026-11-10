import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { frontmatterDescription } from './catalog/normalize.js';
import { frontmatterName } from './install/scan.js';
import type { InstalledSkill } from './install/run.js';

/**
 * What a skill costs in an agent's context. Agents load the name and description
 * of every installed skill when a session starts, to know when to use one; the whole
 * SKILL.md enters the context only when the skill is used, and its other files only
 * when the SKILL.md asks for them. Tokens are estimated, not counted with a tokenizer:
 * about 4 characters per token for Latin text, about one per character for CJK.
 */

/** Estimated tokens of skill descriptions per agent above which the startup load is called heavy. */
export const STARTUP_BUDGET = 5_000;

export function estimateTokens(text: string): number {
  let wide = 0;
  for (const ch of text) if (ch.codePointAt(0)! > 0x2e7f) wide++;
  return Math.ceil((text.length - wide) / 4 + wide);
}

export interface SkillCost {
  /** Loaded at every session start: name and description. */
  startup: number;
  /** Loaded when the skill is used: the whole SKILL.md. */
  onUse: number;
  /** Files and bytes of the skill folder (SKILL.md included), when it is on disk. */
  files?: number;
  bytes?: number;
}

/** Startup and on-use cost of a SKILL.md. */
export function markdownCost(markdown: string, fallbackName = ''): SkillCost {
  const name = frontmatterName(markdown) ?? fallbackName;
  // 1,024 characters: the longest description the Agent Skills spec allows.
  const description = frontmatterDescription(markdown, 1024) ?? '';
  return { startup: estimateTokens(`${name}: ${description}`), onUse: estimateTokens(markdown) };
}

/** The cost of an installed skill folder: its SKILL.md, plus the files and bytes it holds. */
export function folderCost(path: string, name = ''): SkillCost | undefined {
  let markdown: string;
  try {
    markdown = readFileSync(join(path, 'SKILL.md'), 'utf8');
  } catch {
    return undefined;
  }
  let files = 0;
  let bytes = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== '.git' && entry.name !== 'node_modules') walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        files++;
        bytes += statSync(join(dir, entry.name)).size;
      }
    }
  };
  try {
    walk(path);
  } catch {
    // An unreadable subfolder: the counts stay partial, the SKILL.md cost is still right.
  }
  return { ...markdownCost(markdown, name), files, bytes };
}

/** One agent's startup load: the skills it sees and the description tokens they add to every session. */
export interface AgentLoad {
  /** Agent display name, as the scan reports it. */
  agent: string;
  skills: number;
  startup: number;
}

/**
 * The startup load of each agent: the descriptions of every skill it sees, project and
 * global together (an agent started in this project loads both). Heaviest first.
 */
export function agentLoads(installed: InstalledSkill[], cost: (s: InstalledSkill) => SkillCost | undefined = (s) => (s.path ? folderCost(s.path, s.name) : undefined)): AgentLoad[] {
  const loads = new Map<string, AgentLoad>();
  for (const s of installed) {
    const c = cost(s);
    for (const agent of s.agents) {
      const load = loads.get(agent) ?? { agent, skills: 0, startup: 0 };
      load.skills++;
      load.startup += c?.startup ?? 0;
      loads.set(agent, load);
    }
  }
  return [...loads.values()].sort((a, b) => b.startup - a.startup || a.agent.localeCompare(b.agent));
}

/** The agents whose startup load is above the budget. */
export const heavyLoads = (loads: AgentLoad[], budget = STARTUP_BUDGET): AgentLoad[] => loads.filter((l) => l.startup > budget);

/** `12.3 KB`, `840 B`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
