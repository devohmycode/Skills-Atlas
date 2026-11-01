import { Command, Option } from 'commander';
import { renderTerminal as render } from './ui/render.js';
import { styleText } from 'node:util';
import { AGENTS, detectAgents, unknownAgents } from './agents.js';
import { mergeInstalled } from './catalog/installed.js';
import { loadCatalog } from './catalog/load.js';
import { loadLatestCatalog } from './catalog/remote.js';
import { curated } from './catalog/curated.js';
import { deletePack, isBundledPack, packStatus, readPacks, refreshPacks, savePack, updatePack } from './catalog/packs.js';
import pkg from '../package.json' with { type: 'json' };
import { groupByTheme, popularityLabel, querySkills, resolveTheme, sortSkills, SORT_ORDERS, type QueryOptions, type SortOrder } from './catalog/query.js';
import { readConfig, writeConfig } from './config.js';
import { formatNumber, getLang, langFlag, LANGUAGES, normalizeLang, setLang, systemLang, t, themeLabel, type Lang } from './i18n/index.js';
import { formatCommand, parseSkillId, planInstall, planRemovals, planUpdates, type InstallCommand, type Update } from './install/plan.js';
import { nameCollisions } from './install/collisions.js';
import { checkUpdates } from './install/updates.js';
import { dropRevision, readHistory, recordBeforeUpdate, rememberRevision } from './install/history.js';
import { onPath } from './prereqs.js';
import { diagnoseInstalled } from './install/doctor.js';
import { isSuccess, listInstalled, runAll, type CommandOutcome } from './install/run.js';
import { SCOPES, type Catalog, type InstallMethod, type InstallOptions, type Removal, type Scope } from './types.js';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { installedSkills, outdatedSkills, projectSyncPlan, showSkill, skillsByAgent, suggestForProject, type SyncPlan } from './agent-api.js';
import { serveMcp } from './mcp.js';
import { complete, completionScript, type CompletionContext } from './completion.js';
import { auditEnabled, auditSkills, auditTarget, failsAudit } from './audit.js';
import { lockSelection, projectRevisionDrift, type Revisions } from './revisions.js';
import { fetchSkillFiles, fetchSkillMarkdown } from './github.js';
import { riskWhere } from './risks.js';
import { updateDiff } from './install/diff.js';
import { browseLoop } from './browse.js';
import { agentLoads, formatBytes, heavyLoads, STARTUP_BUDGET } from './context.js';
import { scanInstalled } from './install/scan.js';
import { withSuggestions } from './suggest.js';
import { backupScope, listBackups, profilePlan, restoreBackup, type Backup } from './profiles.js';
import { createInterface } from 'node:readline/promises';
import { missingSkills, missingSkillsByAgent, parseSelection, parseSelectionFile, toSelection } from './selection.js';

/** The skills a project expects, at its root, versioned with its code. */
const PROJECT_FILE = 'skills-atlas.json';
import { newerVersion } from './version.js';
import { App, type WizardResult } from './ui/App.js';
import type { TreeAction, TreeMemory } from './ui/TreeSelect.js';
import { Progress } from './ui/Progress.js';
import { colorDepth, logo } from './ui/logo.js';
import { TERMINAL_PALETTE } from './ui/palette.js';
import { enableMouse } from './ui/mouse.js';
import { padEnd, width } from './ui/width.js';
import { openBrowser, startServer } from './web/server.js';

/** Version of the `skills` CLI driven by default; its flags are the contract we rely on. */
const SKILLS_VERSION = '1.7.0';
const LANG_LIST = Object.keys(LANGUAGES).join(', ');

type Style = Parameters<typeof styleText>[0] | 'pink';
/** Colors only on a terminal, so that piped output stays plain. */
const paint = (style: Style, text: string) => {
  if (!process.stdout.isTTY) return text;
  if (style !== 'pink') return styleText(style, text);
  const depth = colorDepth();
  if (depth === 'none') return text;
  if (depth === '256') return styleText('magentaBright', text);
  const rgb = TERMINAL_PALETTE.success.slice(1).match(/../g)!.map((c) => Number.parseInt(c, 16));
  return `\x1b[38;2;${rgb.join(';')}m${text}\x1b[39m`;
};

interface CommonOptions {
  catalog?: string;
  offline?: boolean;
  refresh?: boolean;
  /** Do not print the catalog date after --refresh (the command shows it). */
  quiet?: boolean;
}
interface FilterOptions extends CommonOptions {
  theme?: string[];
  search?: string;
  minInstalls?: number;
  all?: boolean;
  official?: boolean;
  ready?: boolean;
  active?: boolean;
  sort?: SortOrder;
}
interface InstallFlags {
  agent?: string[];
  global?: boolean;
  project?: boolean;
  copy?: boolean;
  symlink?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  /** `--no-audit` sets it to false. */
  audit?: boolean;
  verbose?: boolean;
  /** `--no-mouse` sets it to false. */
  mouse: boolean;
  skillsVersion: string;
}

function fail(message: string): never {
  console.error(`${paint('red', 'skills-atlas:')} ${message}`);
  process.exit(1);
}

/**
 * Interface language, resolved before the commands are built so that their
 * help is translated: `--lang`, then SKILLS_ATLAS_LANG, then the saved
 * choice, then the system's language when we have it, then English.
 */
function resolveLang(argv: string[]): Lang {
  const fromFlag = langFlag(argv);
  if (fromFlag !== undefined) {
    const lang = normalizeLang(fromFlag);
    if (!lang) {
      console.error(`skills-atlas: ${LANGUAGES.en.errors.unknownLang(fromFlag, LANG_LIST)}`);
      process.exit(1);
    }
    // `-l fr` is remembered: later runs keep French without the flag.
    const config = readConfig();
    if (config.lang !== lang) {
      writeConfig({ ...config, lang });
      console.error(LANGUAGES[lang].cli.langSet(lang));
    }
    return lang;
  }
  return normalizeLang(process.env.SKILLS_ATLAS_LANG) ?? normalizeLang(readConfig().lang) ?? systemLang() ?? 'en';
}


/** The catalog of the interactive interfaces: first, the skills suggested for the current directory. */
async function projectCatalog(opts: CommonOptions): Promise<Catalog> {
  const catalog = await openCatalog(opts);
  try {
    const installed = (await Promise.all(SCOPES.map((sc) => listInstalled(sc)))).flat().map((s) => `${s.source ?? 'local'}@${s.name}`);
    return withSuggestions(catalog, process.cwd(), installed);
  } catch {
    // Suggestions are a convenience: a project that cannot be read leaves the catalog as it is.
    return catalog;
  }
}

/** A warning for each agent whose skill descriptions weigh on every session start (listed with `!` in the tree). */
function contextWarnings(): string[] {
  try {
    return heavyLoads(agentLoads(SCOPES.flatMap((sc) => scanInstalled(sc)))).map((l) => c.heavyLoad(l.agent, formatNumber(l.startup), formatNumber(STARTUP_BUDGET)));
  } catch {
    return [];
  }
}

async function openCatalog(opts: CommonOptions): Promise<Catalog> {
  const checked = (catalog: Catalog) => {
    const failed = Object.entries(catalog.stats.sources ?? {}).filter(([, s]) => s.status === 'error').map(([name]) => name);
    if (failed.length) console.error(paint('yellow', t().web.catalogPartial.replace('{sources}', failed.join(', '))));
    return curated(catalog);
  };
  try {
    if (opts.catalog) return checked(await loadCatalog(opts.catalog));
    // Latest snapshot from GitHub (refreshed daily), else the one bundled in the package.
    const catalog = await loadLatestCatalog({
      offline: opts.offline || Boolean(process.env.SKILLS_ATLAS_OFFLINE),
      refresh: opts.refresh,
      onDownload: () => process.stderr.isTTY && console.error(paint('dim', t().cli.updatingCatalog)),
      // Silent fallback normally; with --refresh the user asked for the download, so say it failed.
      onError: (err) =>
        opts.refresh && console.error(paint('yellow', t().cli.refreshFailed(err instanceof Error ? err.message : String(err)))),
    });
    if (opts.refresh && !opts.quiet) {
      console.error(paint('dim', t().cli.catalogOf(catalog.generatedAt.slice(0, 10), formatNumber(catalog.skills.length))));
    }
    return checked(catalog);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function toQuery(catalog: Catalog, opts: FilterOptions): QueryOptions {
  const themes = opts.theme?.map((th) => resolveTheme(catalog, th)?.id ?? fail(t().errors.unknownTheme(th)));
  return { themes, search: opts.search, minInstalls: opts.minInstalls, all: opts.all, official: opts.official, ready: opts.ready ? onPath : undefined, active: opts.active, sort: opts.sort ?? (opts.search?.trim() ? undefined : 'installs') };
}

/** Options fixed by flags; anything left undefined is asked (or defaulted with -y). */
function presetFromFlags(flags: InstallFlags): Partial<Pick<InstallOptions, 'agents' | 'scope' | 'method'>> {
  const e = t().errors;
  if (flags.global && flags.project) fail(e.exclusive('--global', '--project'));
  if (flags.copy && flags.symlink) fail(e.exclusive('--copy', '--symlink'));
  if (flags.agent) {
    const agents = flags.agent.flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
    const unknown = unknownAgents(agents);
    if (unknown.length) fail(e.unknownAgents(unknown.join(', ')));
    flags.agent = agents;
  }
  const scope: Scope | undefined = flags.global ? 'global' : flags.project ? 'project' : undefined;
  const method: InstallMethod | undefined = flags.copy ? 'copy' : flags.symlink ? 'symlink' : undefined;
  return { agents: flags.agent, scope, method };
}

/**
 * Uninstalls `remove` (from each of their scopes), installs `ids` and reinstalls
 * `update`, reporting each skill. Returns the summary line it printed (empty for a dry run).
 */
async function apply(ids: string[], remove: Removal[], options: InstallOptions, flags: InstallFlags, update: Update[] = [], revisions?: Revisions): Promise<string> {
  const r = t().run;
  const commands = [
    ...planRemovals(remove, options.skillsVersion),
    ...(ids.length ? planInstall(ids, options, revisions) : []),
    ...planUpdates(update, options),
  ];
  if (flags.dryRun) {
    for (const c of commands) console.log(formatCommand(c));
    return '';
  }
  // The way back: the version each updated global skill has now, for `rollback`.
  const globalUpdates = update.filter((u) => (u.scope ?? 'global') === 'global');
  if (globalUpdates.length) {
    const missed = await recordBeforeUpdate(globalUpdates.map((u) => u.id));
    if (missed.length) console.error(paint('dim', t().cli.rollbackMissed(missed.join(', '))));
  }
  const config = readConfig();
  // Removals only: nothing was asked, so there is nothing to remember.
  if (ids.length) writeConfig({ ...config, agents: options.agents, scope: options.scope, method: options.method });
  const started = Date.now();
  const outcomes =
    process.stdout.isTTY && !flags.verbose ? await runWithProgress(commands) : await runPlain(commands, options, flags);
  const results = outcomes.flatMap((o) => o.results);
  const installed = results.filter((x) => x.status === 'installed').length;
  const removed = results.filter((x) => x.status === 'removed').length;
  const failed = outcomes.filter((o) => !isSuccess(o)).length;
  const parts = [
    ids.length || update.length
      ? paint(installed === ids.length + update.length ? 'pink' : 'yellow', r.summaryInstalled(installed, ids.length + update.length))
      : '',
    remove.length ? paint(removed === remove.length ? 'pink' : 'yellow', r.summaryRemoved(removed, remove.length)) : '',
    failed ? paint('red', r.summaryFailed(failed)) : '',
    paint('dim', t().progress.finished(`${((Date.now() - started) / 1000).toFixed(1)}s`)),
  ].filter(Boolean);
  const summary = parts.join(paint('dim', '  ·  '));
  console.log(summary);
  if (failed) process.exitCode = 1;
  return summary;
}

/** Stacked progress bars (Ink), for an interactive terminal. */
async function runWithProgress(commands: InstallCommand[]): Promise<CommandOutcome[]> {
  let outcomes: CommandOutcome[] = [];
  const app = render(<Progress commands={commands} onDone={(o) => (outcomes = o)} />);
  await app.waitUntilExit();
  releaseStdin();
  return outcomes;
}

/** One line per step and per skill, for pipes, CI logs and --verbose. */
async function runPlain(commands: InstallCommand[], options: InstallOptions, flags: InstallFlags): Promise<CommandOutcome[]> {
  const r = t().run;
  console.log();
  return runAll(commands, {
    verbose: flags.verbose,
    onStart: (c, i) => {
      const step = paint('dim', `[${i + 1}/${commands.length}]`);
      const what = c.kind === 'remove' ? paint(['bold', 'red'], r.removing) : `${paint('bold', r.installing)} ${paint('dim', c.source)}`;
      console.log(`${step} ${what}`);
    },
    onDone: (o) => {
      for (const res of o.results) {
        const ok = res.status === 'installed' || res.status === 'removed';
        const icon = ok ? paint('pink', '✓') : res.status === 'skipped' ? paint('yellow', '–') : paint('red', '✗');
        const detail =
          res.status === 'installed'
            ? paint('dim', `→ ${(res.agents ?? []).join(', ')}`)
            : res.status === 'removed'
              ? paint('dim', r.removed)
              : paint('red', res.reason ?? res.error ?? r.failed);
        console.log(`      ${icon} ${res.name ?? '?'}  ${detail}`);
      }
      if (!isSuccess(o) && (o.results.length === 0 || o.command.kind === 'remove')) {
        const tail = o.stderr.trim().split('\n').slice(-8).map((l) => `        ${l}`).join('\n');
        if (tail) console.log(paint('dim', `        exit ${o.exitCode}\n${tail}`));
      }
      console.log();
    },
  });
}

/**
 * Ink leaves stdin in raw, flowing mode after unmounting, which keeps the
 * event loop alive: without this the process hangs once installs are done.
 */
function releaseStdin(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdin.unref();
}

/** Fills options missing from the flags with remembered or detected values (non-interactive mode). */
function resolveDefaults() {
  const config = readConfig();
  const detected = detectAgents().map((a) => a.id);
  return {
    defaults: {
      agents: config.agents?.length ? config.agents : detected,
      scope: config.scope ?? ('project' as Scope),
      method: config.method ?? ('symlink' as InstallMethod),
    },
    detected,
  };
}

setLang(resolveLang(process.argv.slice(2)));
const m = t();
const c = m.cli;

const program = new Command()
  .name('skills-atlas')
  .description(c.description)
  .version(pkg.version)
  .addOption(new Option('-l, --lang <code>', c.lang))
  .addHelpText('beforeAll', () => (process.stdout.isTTY ? `\n${logo(process.stdout.columns)}\n` : ''));

const catalogOption = () => new Option('--catalog <path|url>', c.catalog);
const offlineOption = () => new Option('--offline', c.offline);
const refreshOption = () => new Option('--refresh', c.refresh).conflicts('offline');
const filterOptions = (cmd: Command) =>
  cmd
    .option('-t, --theme <theme...>', c.theme)
    .option('-q, --search <text>', c.search)
    .option('--min-installs <n>', c.minInstalls, (v) => Number.parseInt(v, 10))
    .option('--all', c.all)
    .option('--official', c.official)
    .option('--ready', c.ready)
    .option('--active', c.active)
    .addOption(new Option('-s, --sort <order>', c.sort).choices(SORT_ORDERS))
    .addOption(catalogOption())
    .addOption(offlineOption())
    .addOption(refreshOption());
const installOptions = (cmd: Command) =>
  cmd
    .option('-a, --agent <agents...>', c.agent)
    .option('-g, --global', c.global)
    .option('-p, --project', c.project)
    .option('--copy', c.copy)
    .option('--symlink', c.symlink)
    .option('-y, --yes', c.yes)
    .option('--dry-run', c.dryRun)
    .option('--no-audit', c.noAudit)
    .option('--verbose', c.verbose)
    .option('--no-mouse', c.noMouse)
    .option('--skills-version <version>', c.skillsVersion, SKILLS_VERSION);

filterOptions(installOptions(program.command('browse', { isDefault: true })))
  .description(c.browse)
  .action(async (opts: FilterOptions & InstallFlags) => {
    if (!process.stdin.isTTY) fail(m.errors.needsTty);
    let catalog = await projectCatalog(opts);
    let skills = querySkills(catalog, toQuery(catalog, opts));
    if (!skills.length) fail(m.errors.noMatch);
    const preset = presetFromFlags(opts);
    const loadInstalled = async (scopes: Scope[]) =>
      mergeInstalled(catalog.skills, skills, (await Promise.all(scopes.map((sc) => listInstalled(sc)))).flat());
    // Back to the tree after each run, with what is installed now, until the user quits.
    const treeMemory: TreeMemory = {};
    const newer = newerVersion(pkg.version, { offline: opts.offline });
    // Until a run has its own summary to show, the line above the tree tells of a new version.
    const versionNotice = newer ? paint('dim', c.newVersion(newer, pkg.version)) : '';
    const wizard = async (notice: string) => {
      const { defaults, detected } = resolveDefaults();
      let result: WizardResult | null = null;
      const restoreScreen = opts.mouse ? enableMouse() : () => {};
      const app = render(
        <App
          themes={catalog.themes}
          skills={skills}
          preset={preset}
          defaults={defaults}
          detectedAgents={detected}
          skillsVersion={opts.skillsVersion}
          loadInstalled={loadInstalled}
          sort={opts.sort}
          search={opts.search}
          official={opts.official}
          notice={notice || versionNotice}
          warnings={contextWarnings()}
          treeMemory={treeMemory}
          findUpdates={opts.offline ? undefined : (scopes) => checkUpdates(scopes)}
          audit={auditEnabled(readConfig(), opts.audit)}
          packActions
          personalPacks={new Set(readPacks().filter((p) => !isBundledPack(p.id)).map((p) => p.id))}
          onDone={(r) => (result = r)}
        />,
      );
      await app.waitUntilExit();
      restoreScreen();
      releaseStdin();
      return result as WizardResult | null;
    };
    /** A pack, profile or backup key of the tree: done here, in the terminal, then back to the tree. */
    const act = async (action: TreeAction): Promise<string> => {
      let changedPacks = false;
      let notice = '';
      if (action.kind === 'createPack') changedPacks = !!(await createPack(catalog, action.ids));
      else if (action.kind === 'editPack') {
        // Members the tree does not show (filtered out, or gone from the catalog) stay in the pack.
        const shown = new Set(skills.map((s) => s.id));
        const kept = (readPacks().find((p) => p.id === action.pack)?.skills ?? []).filter((id) => !shown.has(id));
        changedPacks = await editPack(catalog, action.pack, { skills: [...action.skills.filter((id) => shown.has(id)), ...kept] });
      } else if (action.kind === 'deletePack') changedPacks = await removePack(action.pack);
      else if (action.kind === 'profile') notice = await useProfile(action.pack, opts, true);
      else notice = await pickAndRestore();
      if (changedPacks) {
        catalog = refreshPacks(catalog);
        skills = querySkills(catalog, toQuery(catalog, opts));
      }
      // Time to read what happened before the tree takes the screen again.
      if (process.stdin.isTTY) await prompt(paint('dim', `${c.backToTree} `));
      return notice;
    };
    const runs = await browseLoop(wizard, (r) => (r.action ? act(r.action) : apply(r.ids, r.remove, r.options, opts, r.update)), opts);
    if (!runs) console.log(paint('dim', m.run.noChange));
  });

filterOptions(program.command('list'))
  .description(c.list)
  .option('--json', c.json)
  .option('-n, --limit <n>', c.limit, (v) => Number.parseInt(v, 10))
  .action(async (opts: FilterOptions & { json?: boolean; limit?: number }) => {
    const catalog = await openCatalog(opts);
    const query = toQuery(catalog, opts);
    // A skill also shows under its secondary theme; with --theme keep only the requested groups.
    const groups = groupByTheme(catalog.themes, querySkills(catalog, query)).filter(
      (g) => !query.themes || query.themes.includes(g.theme.id),
    );
    if (opts.json) {
      const out = groups.map((g) => ({ theme: g.theme, skills: opts.limit ? g.skills.slice(0, opts.limit) : g.skills }));
      process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
      return;
    }
    for (const g of groups) {
      console.log(`\n${paint('bold', themeLabel(g.theme))} ${paint('dim', `(${formatNumber(g.skills.length)})`)}`);
      for (const s of opts.limit ? g.skills.slice(0, opts.limit) : g.skills) {
        console.log(`  ${padEnd(s.id, 60)} ${paint('dim', popularityLabel(s))}`);
      }
    }
  });

program
  .command('ui')
  .description(c.ui)
  .option('--port <n>', c.port, (v) => Number.parseInt(v, 10))
  .option('--no-open', c.noOpen)
  .option('--skills-version <version>', c.skillsVersion, SKILLS_VERSION)
  .addOption(catalogOption())
  .addOption(offlineOption())
  .addOption(refreshOption())
  .action(async (opts: CommonOptions & { port?: number; open: boolean; skillsVersion: string }) => {
    const catalog = await projectCatalog(opts);
    const server = await startServer({
      skills: querySkills(catalog, {}),
      catalogSkills: catalog.skills,
      themes: catalog.themes,
      skillsVersion: opts.skillsVersion,
      port: opts.port,
      sources: catalog.stats.sources,
    }).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
    const w = t().web;
    console.log(`\n  ${w.serving} ${paint(['bold', 'cyan'], server.url)}\n  ${paint('dim', w.stop)}\n`);
    const newer = newerVersion(pkg.version, { offline: opts.offline });
    if (newer) console.log(`  ${paint('dim', c.newVersion(newer, pkg.version))}\n`);
    if (opts.open) openBrowser(server.url);
    // Serves until Ctrl+C.
    await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
    await server.close();
  });

program
  .command('themes')
  .description(c.themes)
  .option('--all', c.themesAll)
  .option('--official', c.official)
  .addOption(catalogOption())
  .addOption(offlineOption())
  .addOption(refreshOption())
  .action(async (opts: FilterOptions) => {
    // The header below already dates the catalog: --refresh need not print it too.
    const catalog = await openCatalog({ ...opts, quiet: true });
    const skills = querySkills(catalog, { all: opts.all, official: opts.official });
    console.log(`\n${paint('bold', c.catalogOf(catalog.generatedAt.slice(0, 10), formatNumber(skills.length)))}\n`);
    const groups = groupByTheme(catalog.themes, skills);
    const labelW = Math.max(...groups.map((g) => width(themeLabel(g.theme))));
    for (const g of groups) {
      console.log(`  ${paint('cyan', g.theme.id.padEnd(14))} ${padEnd(themeLabel(g.theme), labelW)} ${formatNumber(g.skills.length).padStart(7)}`);
    }
    console.log();
  });

program
  .command('agents')
  .description(c.agentsCmd)
  .action(() => {
    const detected = new Set(detectAgents().map((a) => a.id));
    for (const a of AGENTS) {
      const star = detected.has(a.id) ? paint('pink', '★') : ' ';
      console.log(`${star} ${paint('cyan', a.id.padEnd(18))} ${a.displayName.padEnd(22)} ${paint('dim', a.projectDir)}`);
    }
  });

program
  .command('lang')
  .description(c.langCmd)
  .argument('[code]', LANG_LIST)
  .action((code?: string) => {
    if (!code) return console.log(c.langCurrent(getLang(), LANG_LIST));
    const lang = normalizeLang(code) ?? fail(m.errors.unknownLang(code, LANG_LIST));
    writeConfig({ ...readConfig(), lang });
    setLang(lang);
    console.log(t().cli.langSet(lang));
  });

/**
 * The security audit without a person at the keyboard: prints each skill's warning signs and
 * leaves out those that fail it. With the audit off, every id goes through.
 */
async function auditGate(ids: string[], flags: InstallFlags, revisions?: Revisions): Promise<string[]> {
  if (!ids.length || !auditEnabled(readConfig(), flags.audit)) return ids;
  // Offline: the catalog only gives each skill's path, the SKILL.md itself comes from GitHub.
  const catalog = await loadLatestCatalog({ offline: true }).catch(() => undefined);
  const known = new Map(catalog?.skills.map((s) => [s.id.toLowerCase(), s]));
  const left = new Set<string>();
  for (const r of await auditSkills(ids.map((id) => auditTarget(id, known)), s => fetchSkillMarkdown(s, revisions?.[s.id.toLowerCase()]), s => fetchSkillFiles(s, revisions?.[s.id.toLowerCase()]))) {
    for (const x of r.risks.filter((x) => x.level !== 'info')) {
      console.error(paint(x.level === 'high' ? 'red' : 'yellow', `  ${m.tree.riskLevels[x.level]} · ${m.tree.risks[x.rule]}${x.rule === 'missingBin' ? ` (${x.excerpt})` : ''}  ${r.id}  ${riskWhere(x)}`));
    }
    if (r.error) console.error(paint('yellow', `  ? ${r.id}: ${m.confirm.auditUnread}`));
    if (r.error && revisions?.[r.id.toLowerCase()]) fail(`cannot audit pinned skill ${r.id}: ${r.error}`);
    if (failsAudit(r)) {
      console.error(paint('red', `✗ ${c.auditSkipped(r.id)}`));
      left.add(r.id);
    }
  }
  return ids.filter((id) => !left.has(id));
}

/** Installs skills given by id, asking only for the options the flags left open (the tree is skipped). */
async function installIds(ids: string[], opts: InstallFlags, revisions?: Revisions): Promise<void> {
  for (const id of ids) {
    try {
      parseSkillId(id);
    } catch (err) {
      fail((err as Error).message);
    }
  }
  const preset = presetFromFlags(opts);
  if (!preset.agents && (opts.yes || !process.stdin.isTTY)) fail(m.errors.agentRequired);
  const { defaults, detected } = resolveDefaults();
  let options: InstallOptions | undefined;
  const wizard = !(preset.agents && (opts.yes || (preset.scope && preset.method)));
  if (!wizard) {
    options = {
      agents: preset.agents!, // !wizard implies agents were given
      scope: preset.scope ?? defaults.scope,
      method: preset.method ?? defaults.method,
      skillsVersion: opts.skillsVersion,
    };
  } else {
    // Ask only for what the flags left open; the tree is skipped.
    let result: WizardResult | null = null;
    const restoreScreen = opts.mouse ? enableMouse() : () => {};
    const app = render(
      <App
        themes={[]}
        skills={[]}
        preset={preset}
        defaults={defaults}
        detectedAgents={detected}
        skillsVersion={opts.skillsVersion}
        initialIds={ids}
        audit={auditEnabled(readConfig(), opts.audit) && !revisions}
        onDone={(r) => (result = r)}
      />,
    );
    await app.waitUntilExit();
    restoreScreen();
    releaseStdin();
    const chosen = result as WizardResult | null;
    if (!chosen) return;
    options = chosen.options;
    // What the review screen kept: the audit may have left skills out.
    ids = chosen.ids;
  }
  if (!wizard || revisions) {
    const audited = await auditGate(ids, opts, revisions);
    if (revisions && audited.length !== ids.length) process.exitCode = 1;
    ids = audited;
  }
  if (!ids.length) return console.log(paint('dim', m.run.noChange));
  // shortcut: warns but goes on, as -y asked for no question; offer to stop here if users get caught by it.
  const inScope = (await listInstalled(options.scope)).map((s) => `${s.source ?? 'local'}@${s.name}`);
  for (const c of nameCollisions(ids, inScope)) console.error(paint('yellow', `⚠ ${m.confirm.replaces(c.incoming, c.replaced, c.installed)}`));
  await apply(ids, [], options, opts, [], revisions);
}

installOptions(program.command('install'))
  .argument('[ids...]', c.ids)
  .option('--pack <ids...>', c.packOption)
  .description(c.install)
  .action((ids: string[], opts: InstallFlags & { pack?: string[] }) => {
    if (!opts.pack) return ids.length ? installIds(ids, opts) : fail(c.nothingToInstall);
    const packs = readPacks();
    const unknown = opts.pack.filter((id) => !packs.some((p) => p.id === id));
    if (unknown.length) fail(c.unknownPacks(unknown.join(', ')));
    const fromPacks = packs.filter((p) => opts.pack!.includes(p.id)).flatMap((p) => p.skills);
    return installIds([...new Set([...ids, ...fromPacks])], opts);
  });


program.command('lock')
  .description(c.lockCmd)
  .option('--dry-run', c.dryRun)
  .action(async (opts: { dryRun?: boolean }) => {
    try {
      for (const change of await lockSelection(PROJECT_FILE, !!opts.dryRun)) {
        console.log(`${change.id}: ${change.previous ?? '-'} -> ${change.revision}`);
        if (change.compare) console.log(`  ${change.compare}`);
      }
    } catch (err) { fail((err as Error).message); }
  });

installOptions(program.command('sync'))
  .description(c.syncCmd)
  .option('--check', c.syncCheck)
  .action(async (opts: InstallFlags & { check?: boolean }) => {
    let file: ReturnType<typeof parseSelectionFile> = { ids: [] };
    try {
      file = parseSelectionFile(readFileSync(PROJECT_FILE, 'utf8'));
    } catch (err) {
      fail(c.syncFailed(PROJECT_FILE, (err as NodeJS.ErrnoException).code === 'ENOENT' ? c.syncNoFile : (err as Error).message));
    }
    const targets = presetFromFlags({ ...opts, agent: opts.agent ?? file.agents }).agents;
    if (targets && !targets.length) fail(m.errors.agentRequired);
    // Check the requested destinations, even if another agent already has the skill;
    // pinned skills whose installed files drifted from their revision are reinstalled for every target.
    let groups: SyncPlan['groups'] = [];
    try {
      groups = (await projectSyncPlan(file, targets)).groups;
    } catch (err) { fail((err as Error).message); }
    const missing = new Set(groups.flatMap((g) => g.ids));
    if (!missing.size) return console.log(paint('dim', c.syncUpToDate(file.ids.length)));
    if (opts.check) {
      for (const group of groups) for (const id of group.ids) console.log(`  ${id}${group.agents ? `  [${group.agents.join(', ')}]` : ''}`);
      console.error(paint('yellow', c.syncMissing(missing.size)));
      process.exitCode = 1;
      return;
    }
    for (const group of groups) {
      if (group.ids.length) await installIds(group.ids, { ...opts, project: true, global: false, agent: group.agents }, file.revisions);
    }
    if (file.revisions && !opts.dryRun && !process.exitCode) {
      const installed = await listInstalled('project');
      try {
        const absent = missingSkills(file.ids, installed.map(s => `${s.source ?? 'local'}@${s.name}`));
        if (absent.length || (await projectRevisionDrift(file.ids, file.revisions, installed)).length) fail('pinned sync verification failed');
      } catch (err) { fail((err as Error).message); }
    }
  });

/** Asks a yes/no question on the terminal; no is the default. */
async function ask(question: string): Promise<boolean> {
  return /^(y|yes|o|oui|j|ja|s|si|sí|sim)$/i.test(await prompt(`${question} [y/N] `));
}

/** Asks for a line of text on the terminal; an empty answer keeps `fallback`. */
async function prompt(question: string, fallback = ''): Promise<string> {
  // After the tree, stdin is paused and unref'd so that the process can end: a question
  // must hold it again, or Node exits while waiting for the answer.
  process.stdin.ref();
  process.stdin.resume();
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(fallback ? `${question} [${fallback}] ` : question)).trim();
    return answer || fallback;
  } finally {
    rl.close();
    releaseStdin();
  }
}

/** The key a profile is remembered under: `global`, or the project's path. */
const profileKey = (scope: Scope) => (scope === 'global' ? 'global' : resolvePath(process.cwd()));

/** A pack id from its name: `My Docs` → `my-docs`. */
const packId = (name: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pack';

/** Catalog ids for the given ids (any case); the unknown ones are named on stderr and left out. */
function catalogIds(catalog: Catalog, ids: string[]): string[] {
  const byId = new Map(catalog.skills.map((s) => [s.id.toLowerCase(), s.id]));
  const unknown = ids.filter((id) => !byId.has(id.toLowerCase()));
  if (unknown.length) console.error(paint('yellow', c.profileUnknown(unknown.join(', '))));
  return [...new Set(ids.map((id) => byId.get(id.toLowerCase())).filter((id): id is string => !!id))];
}

/** Creates a personal pack; the name and description are asked for when not given. Returns its id, or undefined when nothing was saved. */
async function createPack(catalog: Catalog, ids: string[], given: { name?: string; description?: string } = {}): Promise<string | undefined> {
  const skills = catalogIds(catalog, ids);
  if (!skills.length) {
    console.error(paint('yellow', c.packEmpty));
    return undefined;
  }
  const name = given.name ?? (process.stdin.isTTY ? await prompt(`${c.packNamePrompt} `) : '');
  if (!name) return void console.log(paint('dim', m.run.noChange));
  const description = given.description ?? (process.stdin.isTTY ? await prompt(`${c.packDescriptionPrompt} `, c.profileDefaultDescription(String(skills.length))) : c.profileDefaultDescription(String(skills.length)));
  try {
    const pack = savePack({ id: packId(name), name, description, skills }, catalog.skills);
    console.log(paint('pink', `✓ ${c.profileCreated(pack.id, String(pack.skills.length))}`));
    return pack.id;
  } catch (err) {
    console.error(paint('red', `✗ ${(err as Error).message}`));
    return undefined;
  }
}

/** Names what went wrong, in red, and answers false. */
function refuse(message: string): false {
  console.error(paint('red', `✗ ${message}`));
  return false;
}

/** Changes a personal pack: name and description asked for (Enter keeps them), skills when given. */
async function editPack(catalog: Catalog, id: string, change: { name?: string; description?: string; skills?: string[] } = {}): Promise<boolean> {
  const pack = readPacks().find((p) => p.id === id);
  if (!pack) return refuse(c.unknownPacks(id));
  if (isBundledPack(id)) return refuse(c.packShipped(id));
  const interactive = process.stdin.isTTY && change.name === undefined && change.description === undefined;
  const name = change.name ?? (interactive ? await prompt(c.packNamePrompt, pack.name) : undefined);
  const description = change.description ?? (interactive ? await prompt(c.packDescriptionPrompt, pack.description) : undefined);
  try {
    const saved = updatePack(id, { name, description, skills: change.skills }, catalog.skills);
    console.log(paint('pink', `✓ ${c.packUpdated(saved.id, String(saved.skills.length))}`));
    return true;
  } catch (err) {
    console.error(paint('red', `✗ ${(err as Error).message}`));
    return false;
  }
}

/** Deletes a personal pack after a yes (or -y). */
async function removePack(id: string, yes = false): Promise<boolean> {
  if (!readPacks().some((p) => p.id === id)) return refuse(c.unknownPacks(id));
  if (isBundledPack(id)) return refuse(c.packShipped(id));
  if (!yes && !(process.stdin.isTTY && (await ask(c.packDeleteConfirm(id))))) {
    console.log(paint('dim', m.run.noChange));
    return false;
  }
  deletePack(id);
  console.log(paint('pink', `✓ ${c.packDeleted(id)}`));
  return true;
}

/**
 * Activates a pack as a profile in one scope (asked for in a terminal when no flag
 * says it): shows the plan, asks for a yes, saves the scope, then applies.
 */
async function useProfile(id: string, opts: InstallFlags, askScope = false): Promise<string> {
  const pack = readPacks().find((p) => p.id === id);
  if (!pack) {
    console.error(paint('red', `✗ ${c.unknownPacks(id)}`));
    return '';
  }
  const preset = presetFromFlags(opts);
  let scope: Scope = preset.scope ?? 'global';
  if (!preset.scope && askScope && process.stdin.isTTY) {
    scope = /^p/i.test(await prompt(`${c.profileScopePrompt} `, 'g')) ? 'project' : 'global';
  }
  const installed = await listInstalled(scope);
  const plan = profilePlan(pack, installed);
  console.log(paint('bold', c.profileTitle(pack.name, t().tree.where[scope])));
  console.log(paint('dim', `  ${c.profileKeep(String(plan.keep.length))}`));
  for (const r of plan.remove) console.log(`  ${paint('red', '−')} ${r.id}`);
  for (const i of plan.install) console.log(`  ${paint('pink', '+')} ${i}`);
  if (!plan.remove.length && !plan.install.length) {
    console.log(paint('dim', m.run.noChange));
    return '';
  }
  if (plan.remove.length) console.error(paint('yellow', `⚠ ${c.profileWarning(String(plan.remove.length))}`));
  const { defaults } = resolveDefaults();
  const agents = preset.agents ?? defaults.agents;
  if (plan.install.length && !agents.length) {
    console.error(paint('red', m.errors.agentRequired));
    process.exitCode = 1;
    return '';
  }
  const options: InstallOptions = { agents, scope, method: preset.method ?? defaults.method, skillsVersion: opts.skillsVersion };
  const removals = plan.remove.map((r) => ({ name: r.name, scopes: [scope] }));
  if (opts.dryRun) return apply(plan.install, removals, options, opts);
  if (!opts.yes) {
    if (!process.stdin.isTTY) fail(c.profileNeedsYes);
    if (!(await ask(c.profileConfirm))) {
      console.log(paint('dim', m.run.noChange));
      return '';
    }
  }
  const install = await auditGate(plan.install, opts);
  const backup = backupScope(scope, `profile:${pack.id}`, installed);
  console.log(paint('dim', c.profileBackedUp(backup.id)));
  const summary = await apply(install, removals, options, opts);
  writeConfig({ ...readConfig(), profiles: { ...(readConfig().profiles ?? {}), [profileKey(scope)]: pack.id } });
  console.log(paint('dim', c.profileUndo(backup.id)));
  return summary;
}

/** Prints the backups of the given scopes, numbered from 1, newest first. */
function printBackups(backups: Backup[]): void {
  backups.forEach((b, i) => {
    const tag = b.initial ? paint('pink', ` ${c.profileInitial}`) : '';
    console.log(`  ${paint('dim', String(i + 1).padStart(2))}  ${padEnd(b.id, 40)} ${padEnd(t().tree.where[b.scope], 8)} ${padEnd(String(b.skills.length), 4)} ${paint('dim', b.reason)}${tag}`);
  });
}

/** Puts a scope back as a backup saved it, after a yes (or -y); returns whether it did. */
async function restoreScope(backup: Backup, yes = false): Promise<boolean> {
  console.log(paint('bold', c.profileRestoreTitle(backup.id, t().tree.where[backup.scope], String(backup.skills.length))));
  for (const s of backup.skills) console.log(`  ${s.source ?? 'local'}@${s.name}`);
  if (!yes) {
    if (!process.stdin.isTTY) fail(c.profileNeedsYes);
    if (!(await ask(c.profileRestoreConfirm))) {
      console.log(paint('dim', m.run.noChange));
      return false;
    }
  }
  const undo = restoreBackup(backup.id, await listInstalled(backup.scope));
  const config = readConfig();
  const profiles = { ...(config.profiles ?? {}) };
  delete profiles[backup.scope === 'global' ? 'global' : backup.cwd!];
  writeConfig({ ...config, profiles });
  console.log(paint('pink', `✓ ${c.profileRestored(backup.id)}`));
  console.log(paint('dim', c.profileUndo(undo.id)));
  return true;
}

/** From the tree: the backups listed, one picked by its number (Enter cancels), then restored. */
async function pickAndRestore(): Promise<string> {
  const backups = listBackups();
  if (!backups.length) {
    console.log(paint('dim', c.profileNoBackup));
    return '';
  }
  printBackups(backups);
  const n = Number.parseInt(await prompt(`${c.backupPickPrompt} `), 10);
  const backup = backups[n - 1];
  if (!backup) {
    console.log(paint('dim', m.run.noChange));
    return '';
  }
  return (await restoreScope(backup)) ? paint('pink', `✓ ${c.profileRestored(backup.id)}`) : '';
}

const profile = program.command('profile').description(c.profileCmd);

profile
  .command('list')
  .description(c.profileListCmd)
  .option('--json', c.json)
  .action((opts: { json?: boolean }) => {
    const packs = readPacks();
    const active = readConfig().profiles ?? {};
    const rows = packs.map((p) => ({ id: p.id, name: p.name, description: p.description, skills: p.skills.length, personal: !isBundledPack(p.id), active: SCOPES.filter((sc) => active[profileKey(sc)] === p.id) }));
    if (opts.json) return void process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    for (const r of rows) {
      const mark = r.personal ? paint('pink', '✎ ') : '  ';
      console.log(`${mark}${padEnd(r.id, 24)} ${padEnd(r.name, 30)} ${paint('dim', `${r.skills}`)}${r.active.length ? paint('pink', `  ● ${r.active.map((sc) => t().tree.where[sc]).join(' + ')}`) : ''}`);
    }
    console.log(paint('dim', `\n${c.profileHint}`));
  });

profile
  .command('create')
  .argument('<name>', c.profileName)
  .argument('[ids...]', c.ids)
  .option('--from-installed', c.profileFromInstalled)
  .option('-g, --global', c.global)
  .option('-p, --project', c.project)
  .option('-d, --description <text>', c.profileDescription)
  .addOption(catalogOption())
  .addOption(offlineOption())
  .description(c.profileCreateCmd)
  .action(async (name: string, ids: string[], opts: CommonOptions & { fromInstalled?: boolean; global?: boolean; project?: boolean; description?: string }) => {
    const catalog = await openCatalog({ ...opts, quiet: true });
    const wanted = [...ids];
    if (opts.fromInstalled) wanted.push(...(await installedSkills(flagScopes(opts))).filter((s) => s.source).map((s) => s.id));
    if (!(await createPack(catalog, wanted, { name, description: opts.description ?? c.profileDefaultDescription(String(catalogIds(catalog, wanted).length)) }))) process.exitCode = 1;
  });

profile
  .command('edit')
  .argument('<pack>', c.profilePack)
  .option('--name <name>', c.profileName)
  .option('-d, --description <text>', c.profileDescription)
  .option('--add <ids...>', c.packAddOption)
  .option('--remove <ids...>', c.packRemoveOption)
  .addOption(catalogOption())
  .addOption(offlineOption())
  .description(c.packEditCmd)
  .action(async (id: string, opts: CommonOptions & { name?: string; description?: string; add?: string[]; remove?: string[] }) => {
    const catalog = await openCatalog({ ...opts, quiet: true });
    const pack = readPacks().find((p) => p.id === id);
    let skills: string[] | undefined;
    if (pack && (opts.add || opts.remove)) {
      const drop = new Set((opts.remove ?? []).map((x) => x.toLowerCase()));
      skills = [...pack.skills.filter((s) => !drop.has(s.toLowerCase())), ...catalogIds(catalog, opts.add ?? [])];
    }
    const named = opts.name !== undefined || opts.description !== undefined || skills !== undefined;
    if (!(await editPack(catalog, id, named ? { name: opts.name ?? pack?.name, description: opts.description ?? pack?.description, skills } : {}))) process.exitCode = 1;
  });

profile
  .command('delete')
  .argument('<pack>', c.profilePack)
  .option('-y, --yes', c.yes)
  .description(c.packDeleteCmd)
  .action(async (id: string, opts: { yes?: boolean }) => {
    if (!(await removePack(id, opts.yes))) process.exitCode = 1;
  });

installOptions(profile.command('use'))
  .argument('<pack>', c.profilePack)
  .description(c.profileUseCmd)
  .action(async (id: string, opts: InstallFlags) => {
    if (!readPacks().some((p) => p.id === id)) fail(c.unknownPacks(id));
    await useProfile(id, opts);
  });

profile
  .command('backups')
  .description(c.profileBackupsCmd)
  .option('-g, --global', c.global)
  .option('-p, --project', c.project)
  .option('--json', c.json)
  .action((opts: { global?: boolean; project?: boolean; json?: boolean }) => {
    const scopes = flagScopes(opts);
    const backups = listBackups().filter((b) => scopes.includes(b.scope));
    if (opts.json) return void process.stdout.write(`${JSON.stringify(backups.map(({ dirs: _dirs, ...b }) => b), null, 2)}\n`);
    if (!backups.length) return console.log(paint('dim', c.profileNoBackup));
    printBackups(backups);
    console.log(paint('dim', `\n${c.profileRestoreHint}`));
  });

profile
  .command('restore')
  .argument('[backup]', c.profileBackupArg)
  .option('--initial', c.profileInitialOption)
  .option('-g, --global', c.global)
  .option('-p, --project', c.project)
  .option('-y, --yes', c.yes)
  .description(c.profileRestoreCmd)
  .action(async (id: string | undefined, opts: { initial?: boolean; global?: boolean; project?: boolean; yes?: boolean }) => {
    const backups = listBackups().filter((b) => flagScopes(opts).includes(b.scope));
    const backup = id ? backups.find((b) => b.id === id) : opts.initial ? backups.find((b) => b.initial) : backups[0];
    if (!backup) fail(id ? c.profileUnknownBackup(id) : c.profileNoBackup);
    await restoreScope(backup!, opts.yes);
  });

program
  .command('suggest')
  .argument('[dir]', c.suggestDir, '.')
  .description(c.suggestCmd)
  .option('-n, --limit <n>', c.suggestLimit, (v) => Math.max(1, Math.min(10, Number.parseInt(v, 10) || 3)), 3)
  .addOption(catalogOption())
  .addOption(offlineOption())
  .option('--json', c.json)
  .action(async (dir: string, opts: CommonOptions & { json?: boolean; limit: number }) => {
    const catalog = await openCatalog({ ...opts, quiet: true });
    const found = await suggestForProject(catalog, resolvePath(dir), { perStack: opts.limit });
    if (opts.json) return void process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
    if (!found.stack.length) return console.log(paint('dim', c.suggestNothing));
    const ids: string[] = [];
    for (const s of found.stack) {
      console.log(`\n${paint('bold', s.label)} ${paint('dim', `· ${s.evidence.join(', ')}`)}`);
      if (!s.skills.length) console.log(paint('dim', `  ${c.suggestNone}`));
      for (const k of s.skills) {
        ids.push(k.id);
        const tag = k.official ? paint('pink', ' ◆') : '';
        console.log(`  ${padEnd(k.id, 58)}${tag} ${paint('dim', k.installs ? formatNumber(k.installs) : '')}`);
        if (k.description) console.log(paint('dim', `    ${k.description.length > 100 ? `${k.description.slice(0, 99)}…` : k.description}`));
      }
    }
    if (found.packs.length) console.log(`\n${paint('dim', c.suggestPacks(found.packs.join(', ')))}`);
    if (ids.length) console.log(paint('dim', `\n${c.suggestHint}\n  skills-atlas install ${ids.join(' ')} -p`));
  });

program
  .command('packs')
  .description(c.packsCmd)
  .option('--json', c.json)
  .action(async (opts: { json?: boolean }) => {
    const packs = readPacks();
    const catalog = await openCatalog({ offline: true });
    const status = packs.map((p) => ({ ...p, ...packStatus(p, catalog.skills) }));
    if (opts.json) return void process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    for (const p of status) {
      console.log(`\n${paint('bold', `📦 ${p.name}`)} ${paint('dim', `${p.id} · ${p.available}/${p.total}`)}\n  ${p.description}`);
      for (const id of p.skills) console.log(`  ${paint('dim', id)}`);
      if (p.missing.length) console.log(paint('yellow', t().web.packMissing.replace('{ids}', p.missing.join(', '))));
    }
    console.log(paint('dim', `\n${c.packsHint}`));
  });

program
  .command('completion')
  .argument('<shell>', 'bash, zsh, fish or powershell')
  .description(c.completionCmd)
  .action((shell: string) => {
    const script = completionScript(shell);
    if (!script) fail(c.completionShell(shell));
    process.stdout.write(script);
  });

// Called by the completion scripts on Tab: one candidate per line, nothing else on stdout.
program
  .command('__complete', { hidden: true })
  .argument('[words...]')
  .allowUnknownOption()
  .action(async (words: string[]) => {
    let catalog: Promise<Catalog> | undefined;
    // Offline: Tab must answer at once, from the cached or bundled snapshot.
    const load = () => (catalog ??= loadLatestCatalog({ offline: true }));
    const flags = (cmd: Command) => cmd.options.flatMap((o) => [o.short, o.long].filter((f): f is string => !!f));
    const ctx: CompletionContext = {
      commands: program.commands.filter((cmd) => !cmd.name().startsWith('_')).map((cmd) => ({ name: cmd.name(), options: flags(cmd) })),
      globalOptions: flags(program),
      agents: [...AGENTS.map((a) => a.id), '*'],
      langs: Object.keys(LANGUAGES),
      themes: () => [],
      ids: () => [],
    };
    const needsCatalog = words.length > 1 && ['install', 'show', 'update', 'browse', 'list'].some((w) => words.includes(w));
    if (needsCatalog) {
      const c = await load();
      const sorted = sortSkills(c.skills, 'installs');
      ctx.themes = () => c.themes.map((th) => th.id);
      ctx.ids = (prefix: string) => sorted.filter((s) => s.id.toLowerCase().startsWith(prefix.toLowerCase())).slice(0, 50).map((s) => s.id);
    }
    const out = complete(words.length ? words : [''], ctx);
    if (out.length) process.stdout.write(`${out.join('\n')}\n`);
  });

program
  .command('audit')
  .argument('[state]', 'on or off')
  .description(c.auditCmd)
  .action((state?: string) => {
    if (state !== undefined && state !== 'on' && state !== 'off') fail(c.auditBadValue);
    const config = readConfig();
    if (state) writeConfig({ ...config, audit: state === 'on' });
    console.log(c.auditState(auditEnabled(state ? { audit: state === 'on' } : config)));
  });

program
  .command('doctor')
  .description(m.doctor.command)
  .option('-g, --global', c.global)
  .option('-p, --project', c.project)
  .option('--json', c.json)
  .action((opts: { global?: boolean; project?: boolean; json?: boolean }) => {
    const scopes: Scope[] = opts.global && !opts.project ? ['global'] : opts.project && !opts.global ? ['project'] : SCOPES;
    const issues = scopes.flatMap((scope) => diagnoseInstalled(scope)).map((issue) => ({ ...issue, message: m.doctor.issues[issue.code] }));
    if (issues.length) process.exitCode = 1;
    if (opts.json) return void process.stdout.write(`${JSON.stringify(issues, null, 2)}\n`);
    if (!issues.length) return console.log(paint('dim', m.doctor.healthy));
    for (const issue of issues) console.log(`  ${t().tree.where[issue.scope]} · ${issue.message}: ${issue.path}${issue.name ? ` (${issue.name})` : ''}`);
  });

program
  .command('installed')
  .description(c.installedCmd)
  .option('-g, --global', c.global)
  .option('-p, --project', c.project)
  .option('-a, --agent <ids...>', c.agent)
  .option('--size', c.sizeOption)
  .option('--json', c.json)
  .action(async (opts: { global?: boolean; project?: boolean; agent?: string[]; json?: boolean; size?: boolean }) => {
    const scopes: Scope[] = opts.global && !opts.project ? ['global'] : opts.project && !opts.global ? ['project'] : SCOPES;
    const only = opts.agent?.flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
    const unknown = only ? unknownAgents(only) : [];
    if (unknown.length) fail(m.errors.unknownAgents(unknown.join(', ')));
    const groups = skillsByAgent(await installedSkills(scopes, { cost: opts.size })).filter((g) => !only || only.includes(g.agent));
    // Each agent's startup load: the descriptions of every skill it sees.
    const sized = groups.map((g) => ({ ...g, ...(opts.size ? { startup_tokens: g.skills.reduce((n, s) => n + (s.cost?.startup ?? 0), 0) } : {}) }));
    if (opts.json) return void process.stdout.write(`${JSON.stringify(sized, null, 2)}\n`);
    if (!groups.length) return console.log(paint('dim', c.noneInstalled));
    for (const g of sized) {
      const load = g.startup_tokens === undefined ? '' : ` · ${c.startupLoad(formatNumber(g.startup_tokens))}`;
      console.log(`\n${paint('bold', g.name)} ${paint(g.startup_tokens !== undefined && g.startup_tokens > STARTUP_BUDGET ? 'yellow' : 'dim', `${g.agent} · ${formatNumber(g.skills.length)}${load}`)}`);
      for (const s of g.skills) {
        const size = s.cost ? `  ${padEnd(`≈${formatNumber(s.cost.startup)} / ${formatNumber(s.cost.onUse)} tok`, 22)} ${formatBytes(s.cost.bytes ?? 0)}` : '';
        console.log(`  ${padEnd(s.name, 34)} ${paint('dim', `${padEnd(s.source ?? 'local', 36)} ${padEnd(t().tree.where[s.scope], 8)}${size}`)}`);
      }
    }
    if (opts.size) {
      console.log(paint('dim', `\n${c.sizeLegend}`));
      for (const g of sized.filter((x) => (x.startup_tokens ?? 0) > STARTUP_BUDGET)) console.log(paint('yellow', `⚠ ${c.heavyLoad(g.name, formatNumber(g.startup_tokens!), formatNumber(STARTUP_BUDGET))}`));
    }
  });

program
  .command('mcp')
  .description(c.mcpCmd)
  .option('--skills-version <version>', c.skillsVersion, SKILLS_VERSION)
  .addOption(offlineOption())
  .action((opts: { skillsVersion: string; offline?: boolean }) =>
    serveMcp({
      version: pkg.version,
      audit: auditEnabled(readConfig()),
      skillsVersion: opts.skillsVersion,
      // Silent: stdout carries the protocol, and nobody reads stderr.
      loadCatalog: async () => curated(await loadLatestCatalog({ offline: opts.offline || Boolean(process.env.SKILLS_ATLAS_OFFLINE) })),
    }),
  );

program
  .command('show')
  .argument('<id>', c.ids)
  .description(c.showCmd)
  .option('--json', c.json)
  .addOption(catalogOption())
  .addOption(offlineOption())
  .action(async (id: string, opts: CommonOptions & { json?: boolean }) => {
    const catalog = await openCatalog({ ...opts, quiet: true });
    try {
      const { skill, markdown, risks, cost } = await showSkill(catalog, id);
      if (opts.json) return void process.stdout.write(`${JSON.stringify({ skill, risks, cost, markdown }, null, 2)}\n`);
      console.error(paint('dim', m.tree.cost(formatNumber(cost.startup), formatNumber(cost.onUse))));
      // The warning signs go to stderr: stdout stays the SKILL.md alone, to pipe or save.
      const tree = m.tree;
      console.error(risks.length ? paint('yellow', `⚠ ${tree.risksFound(risks.length)}`) : paint('dim', `✓ ${tree.noRisk}`));
      for (const r of risks) console.error(paint(r.level === 'high' ? 'red' : 'dim', `  ${tree.riskLevels[r.level]} · ${tree.risks[r.rule]}  ${riskWhere(r)}  ${r.excerpt}`));
      process.stdout.write(`${markdown.trimEnd()}\n`);
    } catch (err) {
      fail(c.showFailed(id, err instanceof Error ? err.message : String(err)));
    }
  });

/** Names, on stderr, what an update check could not check (exit code 1), and the project skills edited by hand. */
function reportUnchecked(unchecked: { source: string; reason: string }[], modified: string[] = []): void {
  if (modified.length) console.error(paint('dim', c.updatesModified(modified.join(', '))));
  if (!unchecked.length) return;
  process.exitCode = 1;
  console.error(paint('yellow', c.updatesUnchecked(unchecked.length)));
  for (const u of unchecked) console.error(paint('dim', `  ? ${u.source}: ${u.reason}`));
}

/** `-g` or `-p` alone limits a command to that scope; neither, or both, means both. */
function flagScopes(opts: { global?: boolean; project?: boolean }): Scope[] {
  return opts.global && !opts.project ? ['global'] : opts.project && !opts.global ? ['project'] : SCOPES;
}

installOptions(program.command('update'))
  .argument('[ids...]', c.ids)
  .description(c.updateCmd)
  .action(async (ids: string[], opts: InstallFlags) => {
    const { skills: outdated, unchecked, modified } = await outdatedSkills(flagScopes(opts));
    reportUnchecked(unchecked, modified);
    const wanted = ids.map((id) => id.toLowerCase());
    // Named skills are updated only if they are outdated: a reinstall of an up-to-date one would change nothing.
    const chosen = ids.length ? outdated.filter((s) => wanted.includes(s.id.toLowerCase())) : outdated;
    if (!chosen.length) return unchecked.length ? undefined : console.log(paint('dim', c.upToDate));
    // What each update changes, and the warning signs it brings, before anything runs.
    const local = (await Promise.all([...new Set(chosen.map((s) => s.scope))].map((sc) => listInstalled(sc)))).flat();
    const catalog = await loadLatestCatalog({ offline: true }).catch(() => undefined);
    const known = new Map(catalog?.skills.map((s) => [s.id.toLowerCase(), s]));
    for (const s of chosen) {
      const diff = await updateDiff(auditTarget(s.id, known), local.filter((l) => l.scope === s.scope)).catch(() => undefined);
      const where = s.scope === 'project' ? paint('dim', ` (${m.scope.project})`) : '';
      console.log(`  ${paint('pink', '↑')} ${s.id}${where}${diff ? paint('dim', `  +${diff.added} −${diff.removed}`) : ''}`);
      for (const x of diff?.risks.filter((x) => x.level !== 'info') ?? []) {
        console.log(paint(x.level === 'high' ? 'red' : 'yellow', `      ${m.tree.riskLevels[x.level]} · ${m.tree.risks[x.rule]}  SKILL.md:${x.line}  ${x.excerpt}`));
      }
    }
    // A new version is new content: it is audited like an install.
    const passed = new Set(await auditGate([...new Set(chosen.map((s) => s.id))], opts));
    chosen.splice(0, chosen.length, ...chosen.filter((s) => passed.has(s.id)));
    if (!chosen.length) return console.log(paint('dim', m.run.noChange));
    const { defaults } = resolveDefaults();
    // Each skill keeps its own agents; these options only fill in what a skill's scan did not name.
    const options: InstallOptions = { agents: defaults.agents, scope: 'global', method: opts.copy ? 'copy' : opts.symlink ? 'symlink' : defaults.method, skillsVersion: opts.skillsVersion };
    await apply([], [], options, opts, chosen.map((s) => ({ id: s.id, agents: s.agents, scope: s.scope })));
    // The confirmed updates ran; the rest could not be checked, so this is not a full success.
    if (unchecked.length) console.error(paint('yellow', c.updatesUnchecked(unchecked.length)));
  });

installOptions(program.command('rollback'))
  .argument('<id>', c.ids)
  .option('--list', c.rollbackList)
  .option('--to <sha>', c.rollbackTo)
  .description(c.rollbackCmd)
  .action(async (id: string, opts: InstallFlags & { list?: boolean; to?: string }) => {
    const past = readHistory()[id.toLowerCase()] ?? [];
    if (opts.list) {
      if (!past.length) return console.log(paint('dim', c.rollbackNone(id)));
      console.log(c.rollbackPast(id));
      for (const r of past) console.log(`  ${r.revision}  ${paint('dim', r.replacedAt.slice(0, 16).replace('T', ' '))}`);
      return;
    }
    const skill = (await installedSkills(['global'])).find((s) => s.id.toLowerCase() === id.toLowerCase());
    if (!skill) fail(c.rollbackNotInstalled(id));
    const target = opts.to ? past.find((r) => r.revision.toLowerCase() === opts.to!.toLowerCase()) : past.at(-1);
    if (!target) fail(opts.to ? c.rollbackUnknown(opts.to, id) : c.rollbackNone(id));
    const revisions = { [skill!.id.toLowerCase()]: target!.revision };
    // An old version is content too: audited at that revision, like a pinned install.
    if (!(await auditGate([skill!.id], opts, revisions)).length) return console.log(paint('dim', m.run.noChange));
    const { defaults } = resolveDefaults();
    const options: InstallOptions = { agents: skill!.agents, scope: 'global', method: opts.copy ? 'copy' : opts.symlink ? 'symlink' : defaults.method, skillsVersion: opts.skillsVersion };
    // A rollback reinstalls for the skill's own agents: they are not the choices to remember.
    const remembered = readConfig();
    await apply([skill!.id], [], options, opts, [], revisions);
    if (!opts.dryRun) writeConfig(remembered);
    if (!opts.dryRun && !process.exitCode) {
      dropRevision(skill!.id, target!.revision);
      rememberRevision(skill!.id, target!.revision);
    }
  });

program
  .command('outdated')
  .description(c.outdatedCmd)
  .option('-g, --global', c.global)
  .option('-p, --project', c.project)
  .option('--json', c.json)
  .action(async (opts: { json?: boolean; global?: boolean; project?: boolean }) => {
    const { skills: outdated, unchecked, modified } = await outdatedSkills(flagScopes(opts));
    // stdout keeps the array scripts read; what could not be checked goes to stderr, with exit code 1.
    reportUnchecked(unchecked, modified);
    if (opts.json) return void process.stdout.write(`${JSON.stringify(outdated, null, 2)}\n`);
    if (!outdated.length) return unchecked.length ? undefined : console.log(paint('dim', c.upToDate));
    for (const s of outdated) console.log(`  ${padEnd(s.id, 60)} ${padEnd(s.scope === 'project' ? m.scope.project : m.scope.global, 8)} ${paint('dim', s.agents.join(', '))}`);
    console.log(paint('dim', `\n${c.outdatedHint}`));
    console.log(paint('dim', c.updateAllHint));
  });

program
  .command('export')
  .description(c.exportCmd)
  .option('-g, --global', c.global)
  .option('-p, --project', c.project)
  .action(async (opts: { global?: boolean; project?: boolean }) => {
    const scopes: Scope[] = opts.global && !opts.project ? ['global'] : opts.project && !opts.global ? ['project'] : SCOPES;
    const { selection, skipped } = toSelection((await Promise.all(scopes.map((sc) => listInstalled(sc)))).flat());
    process.stdout.write(`${JSON.stringify(selection, null, 2)}\n`);
    if (skipped.length) console.error(paint('yellow', c.exportSkipped(skipped.join(', '))));
  });

installOptions(program.command('import'))
  .argument('<file>', c.fileArg)
  .description(c.importCmd)
  .action(async (file: string, opts: InstallFlags) => {
    let selection: ReturnType<typeof parseSelectionFile> = { ids: [] };
    try {
      selection = parseSelectionFile(readFileSync(file, 'utf8'));
    } catch (err) {
      fail(c.importFailed(file, err instanceof Error ? err.message : String(err)));
    }
    if (!selection.ids.length) return console.log(paint('dim', m.run.noChange));
    await installIds(selection.ids, opts, selection.revisions);
  });

await program.parseAsync();
// Belt and braces: nothing should outlive the command (stdin, sockets kept alive by fetch…).
// Exit once stdout is flushed, so that piped output (`list --json | …`) is never cut short.
process.stdout.write('', () => process.exit(process.exitCode ?? 0));
