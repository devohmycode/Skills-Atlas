export type Origin = 'claude-plugins.dev' | 'smithery' | 'skills.sh';

/** A skill as reported by one source, before merging. */
export interface RawSkill {
  origin: Origin;
  /** Skill name as `npx skills add --skill` expects it (frontmatter `name`). */
  name: string;
  /** Installable source, `owner/repo` on GitHub. */
  source: string;
  /** Path of the skill directory inside the repo, when known. */
  path?: string;
  description?: string;
  installs?: number;
  stars?: number;
  /** Position in the skills.sh sitemaps, which list the most installed skills first. */
  rank?: number;
  /** Categories assigned by the source itself (Smithery…). */
  labels?: string[];
}

/** A merged, classified catalog entry. */
export interface Skill {
  /** `owner/repo@name` — also accepted by `npx skills add`. */
  id: string;
  name: string;
  source: string;
  path?: string;
  description?: string;
  installs?: number;
  stars?: number;
  rank?: number;
  /** Installs gained since the previous snapshot (crawl time). */
  growth?: number;
  /** What its SKILL.md frontmatter says it needs: programs (`requires.bins`) and the spec's `compatibility` text. */
  requires?: { bins?: string[]; compatibility?: string };
  /** Day its folder last changed on GitHub (YYYY-MM-DD), for the most installed skills. */
  updatedAt?: string;
  /** Published by the vendor itself (its GitHub owner is listed on officialskills.sh). */
  official?: boolean;
  /** Personal editorial selection, independent of popularity or official status. */
  /** `order` is the pick's position in the curated list, which orders its repository group. */
  recommendation?: { repository: string; reason: string; order: number };
  labels: string[];
  origins: Origin[];
  /** Theme ids, 1 or 2, the first being the primary theme. */
  themes: string[];
}

export interface Theme {
  id: string;
  label: string;
  /** What a curated theme (a pack) is for, shown with it. */
  description?: string;
  /** Membership in this snapshot; absence does not prove a skill cannot install. */
  pack?: { available: number; total: number; missing: string[] };
}

export interface Catalog {
  version: 1;
  generatedAt: string;
  themes: Theme[];
  skills: Skill[];
  stats: {
    /** Absent in older snapshots, whose source health is unknown. */
    sources?: Record<Origin, { status: 'ok' | 'error'; count: number; error?: string }>;
    raw: Record<Origin, number>;
    merged: number;
    /** Skills flagged `official` (absent from snapshots older than the flag). */
    official?: number;
    /** Date of the snapshot `growth` is measured against. */
    growthSince?: string;
    byTheme: Record<string, number>;
  };
}

export type Scope = 'project' | 'global';
export const SCOPES: Scope[] = ['project', 'global'];

/** An installed skill to uninstall, from every scope it is installed in. */
export interface Removal {
  name: string;
  scopes: Scope[];
}
export type InstallMethod = 'symlink' | 'copy';

export interface InstallOptions {
  agents: string[];
  scope: Scope;
  method: InstallMethod;
  skillsVersion: string;
}
