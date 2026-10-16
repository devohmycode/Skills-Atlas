import { Command, Option } from 'commander';
import { renderTerminal as render } from './ui/render.js';
import { styleText } from 'node:util';
import { AGENTS, detectAgents, unknownAgents } from './agents.js';
import { mergeInstalled } from './catalog/installed.js';
import { loadCatalog } from './catalog/load.js';
import { loadLatestCatalog } from './catalog/remote.js';
import { withRecommendations } from './catalog/recommended.js';
import pkg from '../package.json' with { type: 'json' };
import { groupByTheme, popularityLabel, querySkills, resolveTheme, SORT_ORDERS, type QueryOptions, type SortOrder } from './catalog/query.js';
import { readConfig, writeConfig } from './config.js';
import { formatNumber, getLang, langFlag, LANGUAGES, normalizeLang, setLang, systemLang, t, themeLabel, type Lang } from './i18n/index.js';
import { formatCommand, parseSkillId, planInstall, planRemovals, type InstallCommand } from './install/plan.js';
import { isSuccess, listInstalled, runAll, type CommandOutcome } from './install/run.js';
import type { Catalog, InstallMethod, InstallOptions, Removal, Scope } from './types.js';
import { App, type WizardResult } from './ui/App.js';
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
    if (opts.catalog) return withRecommendations(await loadCatalog(opts.catalog));
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
    return withRecommendations(catalog);
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

/** Uninstalls `remove` (from each of their scopes), then installs `ids`, reporting each skill. */
/** Returns the summary line it printed (empty for a dry run). */
async function apply(ids: string[], remove: Removal[], options: InstallOptions, flags: InstallFlags): Promise<string> {
  const r = t().run;
  const commands = [...planRemovals(remove, options.skillsVersion), ...(ids.length ? planInstall(ids, options) : [])];
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
    ids.length ? paint(installed === ids.length ? 'pink' : 'yellow', r.summaryInstalled(installed, ids.length)) : '',
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
    for (let runs = 0, notice = ''; ; runs++) {
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
          notice={notice}
          onDone={(r) => (result = r)}
        />,
      );
      await app.waitUntilExit();
      restoreScreen();
      releaseStdin();
      const chosen = result as WizardResult | null;
      if (!chosen) return runs ? undefined : console.log(paint('dim', m.run.noChange));
      notice = await apply(chosen.ids, chosen.remove, chosen.options, opts);
      if (opts.dryRun) return;
    }
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

installOptions(program.command('install'))
  .argument('<ids...>', c.ids)
  .description(c.install)
  .action(async (ids: string[], opts: InstallFlags) => {
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
    if (preset.agents && (opts.yes || (preset.scope && preset.method))) {
      options = {
        agents: preset.agents,
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
          onDone={(r) => (result = r)}
        />,
      );
      await app.waitUntilExit();
      restoreScreen();
      releaseStdin();
      const chosen = result as WizardResult | null;
      if (!chosen) return;
      options = chosen.options;
    }
    await apply(ids, [], options, opts);
  });

await program.parseAsync();
// Belt and braces: nothing should outlive the command (stdin, sockets kept alive by fetch…).
// Exit once stdout is flushed, so that piped output (`list --json | …`) is never cut short.
process.stdout.write('', () => process.exit(process.exitCode ?? 0));
