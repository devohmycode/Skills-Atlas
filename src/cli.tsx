import { Command, Option } from 'commander';
import { renderTerminal as render } from './ui/render.js';
import { styleText } from 'node:util';
import { AGENTS, detectAgents, unknownAgents } from './agents.js';
import { mergeInstalled } from './catalog/installed.js';
import { loadCatalog } from './catalog/load.js';
import { loadLatestCatalog } from './catalog/remote.js';
import { curated } from './catalog/curated.js';
import { readPacks } from './catalog/packs.js';
import pkg from '../package.json' with { type: 'json' };
import { groupByTheme, popularityLabel, querySkills, resolveTheme, sortSkills, SORT_ORDERS, type QueryOptions, type SortOrder } from './catalog/query.js';
import { readConfig, writeConfig } from './config.js';
import { formatNumber, getLang, langFlag, LANGUAGES, normalizeLang, setLang, systemLang, t, themeLabel, type Lang } from './i18n/index.js';
import { formatCommand, parseSkillId, planInstall, planRemovals, planUpdates, type InstallCommand, type Update } from './install/plan.js';
import { nameCollisions } from './install/collisions.js';
import { findUpdates } from './install/updates.js';
import { diagnoseInstalled } from './install/doctor.js';
import { isSuccess, listInstalled, runAll, type CommandOutcome } from './install/run.js';
import { SCOPES, type Catalog, type InstallMethod, type InstallOptions, type Removal, type Scope } from './types.js';
import { readFileSync } from 'node:fs';
import { installedSkills, outdatedSkills, showSkill, skillsByAgent } from './agent-api.js';
import { serveMcp } from './mcp.js';
import { complete, completionScript, type CompletionContext } from './completion.js';
import { auditEnabled, auditSkills, auditTarget, failsAudit } from './audit.js';
import { browseLoop } from './browse.js';
import { missingSkills, parseSelection, parseSelectionFile, toSelection } from './selection.js';

/** The skills a project expects, at its root, versioned with its code. */
const PROJECT_FILE = 'skills-atlas.json';
import { newerVersion } from './version.js';
import { App, type WizardResult } from './ui/App.js';
import type { TreeMemory } from './ui/TreeSelect.js';
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


async function openCatalog(opts: CommonOptions): Promise<Catalog> {
  try {
    if (opts.catalog) return curated(await loadCatalog(opts.catalog));
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
    return curated(catalog);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function toQuery(catalog: Catalog, opts: FilterOptions): QueryOptions {
  const themes = opts.theme?.map((th) => resolveTheme(catalog, th)?.id ?? fail(t().errors.unknownTheme(th)));
  return { themes, search: opts.search, minInstalls: opts.minInstalls, all: opts.all, official: opts.official, sort: opts.sort };
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
async function apply(ids: string[], remove: Removal[], options: InstallOptions, flags: InstallFlags, update: Update[] = []): Promise<string> {
  const r = t().run;
  const commands = [
    ...planRemovals(remove, options.skillsVersion),
    ...(ids.length ? planInstall(ids, options) : []),
    ...planUpdates(update, options),
  ];
  if (flags.dryRun) {
    for (const c of commands) console.log(formatCommand(c));
    return '';
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
    .addOption(new Option('-s, --sort <order>', c.sort).choices(SORT_ORDERS).default('installs'))
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
    const catalog = await openCatalog(opts);
    const skills = querySkills(catalog, toQuery(catalog, opts));
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
          official={opts.official}
          notice={notice || versionNotice}
          treeMemory={treeMemory}
          findUpdates={opts.offline ? undefined : () => findUpdates()}
          audit={auditEnabled(readConfig(), opts.audit)}
          onDone={(r) => (result = r)}
        />,
      );
      await app.waitUntilExit();
      restoreScreen();
      releaseStdin();
      return result as WizardResult | null;
    };
    const runs = await browseLoop(wizard, (r) => apply(r.ids, r.remove, r.options, opts, r.update), opts);
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
    const catalog = await openCatalog(opts);
    const server = await startServer({
      skills: querySkills(catalog, {}),
      catalogSkills: catalog.skills,
      themes: catalog.themes,
      skillsVersion: opts.skillsVersion,
      port: opts.port,
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
async function auditGate(ids: string[], flags: InstallFlags): Promise<string[]> {
  if (!ids.length || !auditEnabled(readConfig(), flags.audit)) return ids;
  // Offline: the catalog only gives each skill's path, the SKILL.md itself comes from GitHub.
  const catalog = await loadLatestCatalog({ offline: true }).catch(() => undefined);
  const known = new Map(catalog?.skills.map((s) => [s.id.toLowerCase(), s]));
  const left = new Set<string>();
  for (const r of await auditSkills(ids.map((id) => auditTarget(id, known)))) {
    for (const x of r.risks.filter((x) => x.level !== 'info')) {
      console.error(paint(x.level === 'high' ? 'red' : 'yellow', `  ${m.tree.riskLevels[x.level]} · ${m.tree.risks[x.rule]}  ${r.id}  SKILL.md:${x.line}`));
    }
    if (r.error) console.error(paint('yellow', `  ? ${r.id}: ${m.confirm.auditUnread}`));
    if (failsAudit(r)) {
      console.error(paint('red', `✗ ${c.auditSkipped(r.id)}`));
      left.add(r.id);
    }
  }
  return ids.filter((id) => !left.has(id));
}

/** Installs skills given by id, asking only for the options the flags left open (the tree is skipped). */
async function installIds(ids: string[], opts: InstallFlags): Promise<void> {
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
        audit={auditEnabled(readConfig(), opts.audit)}
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
  if (!wizard) ids = await auditGate(ids, opts);
  if (!ids.length) return console.log(paint('dim', m.run.noChange));
  // shortcut: warns but goes on, as -y asked for no question; offer to stop here if users get caught by it.
  const inScope = (await listInstalled(options.scope)).map((s) => `${s.source ?? 'local'}@${s.name}`);
  for (const c of nameCollisions(ids, inScope)) console.error(paint('yellow', `⚠ ${m.confirm.replaces(c.incoming, c.replaced, c.installed)}`));
  await apply(ids, [], options, opts);
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

installOptions(program.command('sync'))
  .description(c.syncCmd)
  .option('--check', c.syncCheck)
  .action(async (opts: InstallFlags & { check?: boolean }) => {
    let file: { ids: string[]; agents?: string[] } = { ids: [] };
    try {
      file = parseSelectionFile(readFileSync(PROJECT_FILE, 'utf8'));
    } catch (err) {
      fail(c.syncFailed(PROJECT_FILE, (err as NodeJS.ErrnoException).code === 'ENOENT' ? c.syncNoFile : (err as Error).message));
    }
    // The project's skills, in the project: they travel with the code.
    const installed = (await listInstalled('project')).map((s) => `${s.source ?? 'local'}@${s.name}`);
    const missing = missingSkills(file.ids, installed);
    if (!missing.length) return console.log(paint('dim', c.syncUpToDate(file.ids.length)));
    if (opts.check) {
      for (const id of missing) console.log(`  ${id}`);
      console.error(paint('yellow', c.syncMissing(missing.length)));
      process.exitCode = 1;
      return;
    }
    await installIds(missing, { ...opts, project: true, global: false, agent: opts.agent ?? file.agents });
  });

program
  .command('packs')
  .description(c.packsCmd)
  .option('--json', c.json)
  .action((opts: { json?: boolean }) => {
    const packs = readPacks();
    if (opts.json) return void process.stdout.write(`${JSON.stringify(packs, null, 2)}\n`);
    for (const p of packs) {
      console.log(`\n${paint('bold', `📦 ${p.name}`)} ${paint('dim', `${p.id} · ${formatNumber(p.skills.length)}`)}\n  ${p.description}`);
      for (const id of p.skills) console.log(`  ${paint('dim', id)}`);
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
  .option('--json', c.json)
  .action(async (opts: { global?: boolean; project?: boolean; agent?: string[]; json?: boolean }) => {
    const scopes: Scope[] = opts.global && !opts.project ? ['global'] : opts.project && !opts.global ? ['project'] : SCOPES;
    const only = opts.agent?.flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
    const unknown = only ? unknownAgents(only) : [];
    if (unknown.length) fail(m.errors.unknownAgents(unknown.join(', ')));
    const groups = skillsByAgent(await installedSkills(scopes)).filter((g) => !only || only.includes(g.agent));
    if (opts.json) return void process.stdout.write(`${JSON.stringify(groups, null, 2)}\n`);
    if (!groups.length) return console.log(paint('dim', c.noneInstalled));
    for (const g of groups) {
      console.log(`\n${paint('bold', g.name)} ${paint('dim', `${g.agent} · ${formatNumber(g.skills.length)}`)}`);
      for (const s of g.skills) console.log(`  ${padEnd(s.name, 34)} ${paint('dim', `${padEnd(s.source ?? 'local', 36)} ${t().tree.where[s.scope]}`)}`);
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
      const { skill, markdown, risks } = await showSkill(catalog, id);
      if (opts.json) return void process.stdout.write(`${JSON.stringify({ skill, risks, markdown }, null, 2)}\n`);
      // The warning signs go to stderr: stdout stays the SKILL.md alone, to pipe or save.
      const tree = m.tree;
      console.error(risks.length ? paint('yellow', `⚠ ${tree.risksFound(risks.length)}`) : paint('dim', `✓ ${tree.noRisk}`));
      for (const r of risks) console.error(paint(r.level === 'high' ? 'red' : 'dim', `  ${tree.riskLevels[r.level]} · ${tree.risks[r.rule]}  SKILL.md:${r.line}  ${r.excerpt}`));
      process.stdout.write(`${markdown.trimEnd()}\n`);
    } catch (err) {
      fail(c.showFailed(id, err instanceof Error ? err.message : String(err)));
    }
  });

installOptions(program.command('update'))
  .argument('[ids...]', c.ids)
  .description(c.updateCmd)
  .action(async (ids: string[], opts: InstallFlags) => {
    const outdated = await outdatedSkills();
    const wanted = ids.map((id) => id.toLowerCase());
    // Named skills are updated only if they are outdated: a reinstall of an up-to-date one would change nothing.
    const chosen = ids.length ? outdated.filter((s) => wanted.includes(s.id.toLowerCase())) : outdated;
    if (!chosen.length) return console.log(paint('dim', c.upToDate));
    for (const s of chosen) console.log(`  ${paint('pink', '↑')} ${s.id}`);
    // A new version is new content: it is audited like an install.
    const passed = new Set(await auditGate(chosen.map((s) => s.id), opts));
    chosen.splice(0, chosen.length, ...chosen.filter((s) => passed.has(s.id)));
    if (!chosen.length) return console.log(paint('dim', m.run.noChange));
    const { defaults } = resolveDefaults();
    // Each skill keeps its own agents; these options only fill in what a skill's scan did not name.
    const options: InstallOptions = { agents: defaults.agents, scope: 'global', method: opts.copy ? 'copy' : opts.symlink ? 'symlink' : defaults.method, skillsVersion: opts.skillsVersion };
    await apply([], [], options, opts, chosen.map((s) => ({ id: s.id, agents: s.agents })));
  });

program
  .command('outdated')
  .description(c.outdatedCmd)
  .option('--json', c.json)
  .action(async (opts: { json?: boolean }) => {
    const outdated = await outdatedSkills();
    if (opts.json) return void process.stdout.write(`${JSON.stringify(outdated, null, 2)}\n`);
    if (!outdated.length) return console.log(paint('dim', c.upToDate));
    for (const s of outdated) console.log(`  ${padEnd(s.id, 60)} ${paint('dim', s.agents.join(', '))}`);
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
    let ids: string[] = [];
    try {
      ids = parseSelection(readFileSync(file, 'utf8'));
    } catch (err) {
      fail(c.importFailed(file, err instanceof Error ? err.message : String(err)));
    }
    if (!ids.length) return console.log(paint('dim', m.run.noChange));
    await installIds(ids, opts);
  });

await program.parseAsync();
// Belt and braces: nothing should outlive the command (stdin, sockets kept alive by fetch…).
// Exit once stdout is flushed, so that piped output (`list --json | …`) is never cut short.
process.stdout.write('', () => process.exit(process.exitCode ?? 0));
