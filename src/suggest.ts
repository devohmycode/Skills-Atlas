import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isStale } from './catalog/query.js';
import type { Catalog, Skill, Theme } from './types.js';

/**
 * Skills for the project at hand: what its manifests and files say it uses
 * (frameworks, databases, tools), then the catalog skills named after each of
 * them. Nothing leaves the machine: the project is read, the catalog is local.
 */

/** A technology found in the project, with what gave it away (`package.json: react`). */
export interface StackSignal {
  id: string;
  label: string;
  evidence: string[];
}

interface StackRule {
  id: string;
  label: string;
  /** npm packages, exact or `@scope/*`. */
  npm?: string[];
  /** Python distributions, as requirements and pyproject list them. */
  python?: string[];
  /** Rust crates in Cargo.toml. */
  crates?: string[];
  /** Files or folders whose presence is enough, relative to the project root. */
  files?: string[];
  /** File names, at the root, matching this. */
  rootFile?: RegExp;
  /** Other text manifests and a word they must hold (`Gemfile` + `rails`). */
  manifest?: [file: string, word: RegExp][];
  /** Words of a skill's name that make it a match (long ones also inside a joined name: `nextjs-app`). */
  names: string[];
  /** Words that make a name about something else (`react-native` is not React). */
  exclude?: string[];
  /** GitHub owners who publish this technology: their skills come first and match by owner alone. */
  owners?: string[];
  /** Skills to suggest first when the catalog has them. */
  ids?: string[];
  /** Curated packs that fit. */
  packs?: string[];
}

const RULES: StackRule[] = [
  { id: 'react', label: 'React', npm: ['react'], names: ['react'], exclude: ['native'], ids: ['vercel-labs/agent-skills@vercel-react-best-practices'], packs: ['frontend'] },
  { id: 'nextjs', label: 'Next.js', npm: ['next'], files: ['next.config.js', 'next.config.mjs', 'next.config.ts'], names: ['nextjs'], packs: ['frontend'] },
  { id: 'vue', label: 'Vue', npm: ['vue'], names: ['vue', 'pinia'], owners: ['vuejs-ai'], packs: ['frontend'] },
  { id: 'nuxt', label: 'Nuxt', npm: ['nuxt'], files: ['nuxt.config.ts', 'nuxt.config.js'], names: ['nuxt'], owners: ['nuxt'], packs: ['frontend'] },
  { id: 'svelte', label: 'Svelte', npm: ['svelte', '@sveltejs/kit'], files: ['svelte.config.js'], names: ['svelte', 'sveltekit', 'svelte5'], owners: ['sveltejs'], packs: ['frontend'] },
  { id: 'angular', label: 'Angular', npm: ['@angular/core'], files: ['angular.json'], names: ['angular'], owners: ['angular'], packs: ['frontend'] },
  { id: 'astro', label: 'Astro', npm: ['astro'], files: ['astro.config.mjs', 'astro.config.ts'], names: ['astro'], packs: ['frontend'] },
  { id: 'tailwind', label: 'Tailwind CSS', npm: ['tailwindcss', '@tailwindcss/*'], files: ['tailwind.config.js', 'tailwind.config.ts', 'tailwind.config.cjs'], names: ['tailwind', 'tailwindcss'], packs: ['frontend'] },
  { id: 'shadcn', label: 'shadcn/ui', files: ['components.json'], npm: ['shadcn'], names: ['shadcn'], owners: ['shadcn-ui'], packs: ['frontend'] },
  { id: 'react-native', label: 'React Native', npm: ['react-native'], names: ['reactnative'], packs: ['frontend'] },
  { id: 'expo', label: 'Expo', npm: ['expo'], names: ['expo', 'eas'], owners: ['expo'] },
  { id: 'electron', label: 'Electron', npm: ['electron'], names: ['electron'] },
  { id: 'tauri', label: 'Tauri', npm: ['@tauri-apps/api'], crates: ['tauri'], files: ['src-tauri'], names: ['tauri'] },
  { id: 'remotion', label: 'Remotion', npm: ['remotion', '@remotion/*'], names: ['remotion'], owners: ['remotion-dev'] },
  { id: 'typescript', label: 'TypeScript', npm: ['typescript'], files: ['tsconfig.json'], names: ['typescript'] },
  { id: 'supabase', label: 'Supabase', npm: ['@supabase/*'], python: ['supabase'], files: ['supabase/config.toml'], names: ['supabase'], owners: ['supabase'] },
  { id: 'prisma', label: 'Prisma', npm: ['prisma', '@prisma/client'], files: ['prisma/schema.prisma'], names: ['prisma'], owners: ['prisma'] },
  { id: 'drizzle', label: 'Drizzle ORM', npm: ['drizzle-orm', 'drizzle-kit'], names: ['drizzle'] },
  { id: 'postgres', label: 'PostgreSQL', npm: ['pg', 'postgres', '@neondatabase/serverless'], python: ['psycopg', 'psycopg2', 'psycopg2-binary', 'asyncpg'], names: ['postgres', 'postgresql'] },
  { id: 'mongodb', label: 'MongoDB', npm: ['mongodb', 'mongoose'], python: ['pymongo', 'motor'], names: ['mongodb', 'mongo'], owners: ['mongodb'] },
  { id: 'firebase', label: 'Firebase', npm: ['firebase', 'firebase-admin'], files: ['firebase.json'], names: ['firebase'], owners: ['firebase'] },
  { id: 'convex', label: 'Convex', npm: ['convex'], files: ['convex'], names: ['convex'], owners: ['convex'] },
  { id: 'clerk', label: 'Clerk', npm: ['@clerk/*'], names: ['clerk'], owners: ['clerk'] },
  { id: 'stripe', label: 'Stripe', npm: ['stripe', '@stripe/*'], python: ['stripe'], names: ['stripe'], owners: ['stripe'] },
  { id: 'cloudflare', label: 'Cloudflare Workers', npm: ['wrangler', '@cloudflare/*'], files: ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc'], names: ['cloudflare', 'wrangler'], owners: ['cloudflare'] },
  { id: 'vercel', label: 'Vercel', npm: ['vercel', '@vercel/*'], files: ['vercel.json'], names: ['vercel'], owners: ['vercel-labs'] },
  { id: 'playwright', label: 'Playwright', npm: ['@playwright/test', 'playwright'], python: ['playwright', 'pytest-playwright'], files: ['playwright.config.ts', 'playwright.config.js'], names: ['playwright'], packs: ['quality'] },
  { id: 'vitest', label: 'Vitest', npm: ['vitest'], files: ['vitest.config.ts', 'vitest.config.js'], names: ['vitest'], packs: ['quality'] },
  { id: 'jest', label: 'Jest', npm: ['jest'], files: ['jest.config.js', 'jest.config.ts'], names: ['jest'], packs: ['quality'] },
  { id: 'pytest', label: 'pytest', python: ['pytest'], files: ['pytest.ini', 'conftest.py'], names: ['pytest'], packs: ['quality'] },
  { id: 'fastapi', label: 'FastAPI', python: ['fastapi'], names: ['fastapi'], owners: ['fastapi'] },
  { id: 'django', label: 'Django', python: ['django'], files: ['manage.py'], names: ['django'] },
  { id: 'anthropic', label: 'Claude API', npm: ['@anthropic-ai/sdk'], python: ['anthropic'], names: [], ids: ['anthropics/skills@claude-api'] },
  { id: 'mcp', label: 'MCP server', npm: ['@modelcontextprotocol/sdk'], python: ['mcp', 'fastmcp'], names: [], ids: ['anthropics/skills@mcp-builder'] },
  { id: 'go', label: 'Go', files: ['go.mod'], names: ['golang'] },
  { id: 'rust', label: 'Rust', files: ['Cargo.toml'], names: ['rust', 'cargo'] },
  { id: 'swift', label: 'Swift', files: ['Package.swift'], rootFile: /\.xcodeproj$/, names: ['swift', 'swiftui'] },
  { id: 'flutter', label: 'Flutter', files: ['pubspec.yaml'], names: ['flutter', 'dart'], owners: ['flutter'] },
  { id: 'dotnet', label: '.NET', rootFile: /\.(csproj|fsproj|sln)$/, names: ['dotnet', 'csharp'] },
  { id: 'rails', label: 'Ruby on Rails', manifest: [['Gemfile', /^\s*gem\s+["']rails["']/m]], names: ['rails'] },
  { id: 'laravel', label: 'Laravel', manifest: [['composer.json', /"laravel\/framework"/]], names: ['laravel'] },
  { id: 'docker', label: 'Docker', files: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'], names: ['docker', 'dockerfile'] },
  { id: 'kubernetes', label: 'Kubernetes', files: ['Chart.yaml', 'kustomization.yaml', 'k8s', 'helm'], names: ['kubernetes', 'k8s', 'helm'] },
  { id: 'terraform', label: 'Terraform', rootFile: /\.tf$/, files: ['terraform'], names: ['terraform'], owners: ['hashicorp'] },
  { id: 'github-actions', label: 'GitHub Actions', files: ['.github/workflows'], names: ['githubactions', 'cicd'] },
];

/** Owners publishing one of the technologies above. */
const VENDORS = new Set(RULES.flatMap((r) => r.owners ?? []));

/** Workspace folders of a monorepo, one level down, read like the root. */
const WORKSPACES = ['apps', 'packages', 'services'];

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Every package.json dependency name, root and workspaces, with the file that lists it. */
function npmDependencies(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const dirs = [root, ...WORKSPACES.flatMap((w) => listDir(join(root, w)).map((d) => join(root, w, d)))];
  for (const dir of dirs) {
    const text = readText(join(dir, 'package.json'));
    if (!text) continue;
    let pkg: Record<string, unknown>;
    try {
      pkg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const where = dir === root ? 'package.json' : `${dir.slice(root.length + 1).replace(/\\/g, '/')}/package.json`;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const deps = pkg[field];
      if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) if (!out.has(name)) out.set(name, where);
    }
  }
  return out;
}

/** Python distribution names (lower case, `_` read as `-`) of requirements files, pyproject.toml, Pipfile and setup.py. */
function pythonDependencies(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const files = [...listDir(root).filter((f) => /^requirements.*\.(txt|in)$/i.test(f)), 'pyproject.toml', 'Pipfile', 'setup.py', 'setup.cfg'];
  for (const file of files) {
    const text = readText(join(root, file));
    if (!text) continue;
    // A name starts a line or a quoted string, and ends at a version, an extra, a marker or the quote.
    for (const m of text.matchAll(/(?:^|["'\s,[])([A-Za-z][A-Za-z0-9._-]*)\s*(?=[<>=~!;[\]"',]|\s*$|\s+[<>=~!(])/gm)) {
      const name = m[1]!.toLowerCase().replace(/_/g, '-');
      if (!out.has(name)) out.set(name, file);
    }
  }
  return out;
}

/** Crate names under the `[dependencies]` tables of Cargo.toml (root and `src-tauri`). */
function rustCrates(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of ['Cargo.toml', 'src-tauri/Cargo.toml']) {
    const text = readText(join(root, file));
    if (!text) continue;
    let inDeps = false;
    for (const line of text.split(/\r?\n/)) {
      const table = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
      if (table) inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(table.trim());
      else if (inDeps) {
        const name = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
        if (name && !out.has(name)) out.set(name, file);
      }
    }
  }
  return out;
}

const npmMatch = (pattern: string, name: string) => (pattern.endsWith('/*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern);

/** What the project at `root` is built with, in the order of the rules. Reads files only, never runs anything. */
export function detectStack(root: string): StackSignal[] {
  const npm = npmDependencies(root);
  const python = pythonDependencies(root);
  const crates = rustCrates(root);
  const rootFiles = listDir(root);
  const signals: StackSignal[] = [];
  for (const rule of RULES) {
    const evidence: string[] = [];
    for (const p of rule.npm ?? []) for (const [name, file] of npm) if (npmMatch(p, name)) evidence.push(`${file}: ${name}`);
    for (const p of rule.python ?? []) if (python.has(p)) evidence.push(`${python.get(p)}: ${p}`);
    for (const c of rule.crates ?? []) if (crates.has(c)) evidence.push(`${crates.get(c)}: ${c}`);
    for (const f of rule.files ?? []) if (existsSync(join(root, f))) evidence.push(statSync(join(root, f)).isDirectory() ? `${f}/` : f);
    if (rule.rootFile) for (const f of rootFiles.filter((f) => rule.rootFile!.test(f)).slice(0, 2)) evidence.push(f);
    for (const [file, word] of rule.manifest ?? []) if (word.test(readText(join(root, file)) ?? '')) evidence.push(file);
    if (evidence.length) signals.push({ id: rule.id, label: rule.label, evidence: [...new Set(evidence)].slice(0, 3) });
  }
  return signals;
}

/** A technology of the project and the skills suggested for it. */
export interface StackSuggestion extends StackSignal {
  skills: Skill[];
}

export interface Suggestions {
  stack: StackSuggestion[];
  /** Curated packs that fit what was found. */
  packs: string[];
}

export interface SuggestOptions {
  /** `owner/repo@name` (any case) of what is installed: never suggested again. */
  installed?: Iterable<string>;
  /** Skills per technology, 3 by default. */
  perStack?: number;
  /** Skills installed fewer times are left out, 500 by default. A preferred skill always passes. */
  minInstalls?: number;
}

const words = (name: string) => name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function matches(rule: StackRule, s: Skill): boolean {
  const owner = s.source.split('/')[0]!.toLowerCase();
  if (rule.owners?.includes(owner)) return true;
  const w = words(s.name);
  if (rule.exclude?.some((x) => w.includes(x))) return false;
  const joined = w.join('');
  return rule.names.some((n) => w.includes(n) || (n.length > 5 && joined.includes(n)));
}

/**
 * Catalog skills for each technology found: the rule's own picks first, then
 * its publishers' skills, then skills named after it, then the most installed. Skills
 * already installed, of archived or idle repositories, deprecated, or below
 * the install threshold are left out; a skill shows under the first technology
 * that suggests it, and copies of one name in several repositories count once.
 */
export function suggestSkills(catalog: Catalog, signals: StackSignal[], opts: SuggestOptions = {}): Suggestions {
  const perStack = opts.perStack ?? 3;
  const minInstalls = opts.minInstalls ?? 500;
  const installed = new Set([...(opts.installed ?? [])].map((id) => id.toLowerCase()));
  const byId = new Map(catalog.skills.map((s) => [s.id.toLowerCase(), s]));
  const taken = new Set<string>();
  const stack: StackSuggestion[] = [];
  const packs = new Set<string>();
  for (const signal of signals) {
    const rule = RULES.find((r) => r.id === signal.id);
    if (!rule) continue;
    for (const p of rule.packs ?? []) packs.add(p);
    const usable = (s: Skill) => !installed.has(s.id.toLowerCase()) && !taken.has(s.id.toLowerCase()) && !isStale(s) && !/\bdeprecated\b/i.test(s.description ?? '');
    const preferred = (rule.ids ?? []).map((id) => byId.get(id.toLowerCase())).filter((s): s is Skill => !!s && usable(s));
    // Publisher's own skills first, then names that start with the technology, then the rest;
    // another technology's publisher (an integration such as `auth0-nextjs`) comes last.
    const rank = (s: Skill) => {
      const owner = s.source.split('/')[0]!.toLowerCase();
      if (rule.owners?.includes(owner)) return 0;
      if (VENDORS.has(owner)) return 3;
      const first = words(s.name)[0] ?? '';
      return rule.names.includes(first) || rule.names.some((n) => n.length > 5 && words(s.name).join('').startsWith(n)) ? 1 : 2;
    };
    const found = catalog.skills
      .filter((s) => (s.installs ?? 0) >= minInstalls && usable(s) && matches(rule, s))
      .sort((a, b) => rank(a) - rank(b) || (b.installs ?? 0) - (a.installs ?? 0));
    const names = new Set<string>();
    const skills: Skill[] = [];
    for (const s of [...preferred, ...found]) {
      if (skills.length >= perStack) break;
      const name = s.name.toLowerCase();
      if (names.has(name) || skills.includes(s)) continue;
      names.add(name);
      skills.push(s);
      taken.add(s.id.toLowerCase());
    }
    stack.push({ ...signal, skills });
  }
  return { stack, packs: [...packs] };
}

export const SUGGESTED_THEME: Theme = { id: 'suggested', label: 'For this project' };

/**
 * The catalog with a first theme holding the skills suggested for the project in `dir`
 * (the tree and the web page show it), each marked with the technology it fits.
 * Unchanged when nothing is found or nothing new fits.
 */
export function withSuggestions(catalog: Catalog, dir: string, installed: Iterable<string> = []): Catalog {
  const found = suggestSkills(catalog, detectStack(dir), { installed });
  const picks = new Map<string, { for: string; order: number }>();
  for (const st of found.stack) for (const s of st.skills) picks.set(s.id, { for: st.label, order: picks.size });
  if (!picks.size) return catalog;
  const skills = catalog.skills.map((s) => {
    const pick = picks.get(s.id);
    return pick ? { ...s, suggestion: pick, themes: [...s.themes, SUGGESTED_THEME.id] } : s;
  });
  const used = found.stack.filter((st) => st.skills.length);
  const theme: Theme = { ...SUGGESTED_THEME, description: used.map((st) => `${st.label} (${st.evidence[0]})`).join(' · ') };
  const themes = [theme, ...catalog.themes.filter((th) => th.id !== SUGGESTED_THEME.id)];
  return { ...catalog, skills, themes, stats: { ...catalog.stats, byTheme: { ...catalog.stats.byTheme, [SUGGESTED_THEME.id]: picks.size } } };
}

/** The technologies a rule can detect, for help texts and tests. */
export const STACK_IDS = RULES.map((r) => r.id);
