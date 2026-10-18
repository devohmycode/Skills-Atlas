import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useState, type ReactNode } from 'react';
import { AGENTS, getAgent } from '../agents.js';
import { INSTALLED_THEME, type TreeData } from '../catalog/installed.js';
import type { SortOrder } from '../catalog/query.js';
import { t } from '../i18n/index.js';
import { nameCollisions, type Collision } from '../install/collisions.js';
import { formatCommand, planInstall, planRemovals, planUpdates, type Update } from '../install/plan.js';
import { SCOPES, type InstallMethod, type InstallOptions, type Removal, type Scope, type Skill, type Theme } from '../types.js';
import { Banner, Header, Hints, Panel, useTerminalSize, type StepId } from './Layout.js';
import { ListSelect } from './ListSelect.js';
import { isMouseInput } from './mouse.js';
import { padEnd } from './width.js';
import { scopesLabel, TreeSelect, type TreeMemory } from './TreeSelect.js';
import { TERMINAL_PALETTE as PALETTE } from './palette.js';

export interface WizardResult {
  /** Skills to install (`owner/repo@name`). */
  ids: string[];
  /** Installed skills to uninstall, from every scope they are in. */
  remove: Removal[];
  /** Installed skills to reinstall at their latest version. */
  update: Update[];
  options: InstallOptions;
}

export interface AppProps {
  themes: Theme[];
  skills: Skill[];
  /** Options given on the command line: their prompts are skipped. */
  preset: Partial<Pick<InstallOptions, 'agents' | 'scope' | 'method'>>;
  /** Pre-filled values for the prompts (remembered choices, detected agents). */
  defaults: { agents: string[]; scope: Scope; method: InstallMethod };
  /** Agents found on this machine, flagged in the agent list. */
  detectedAgents?: string[];
  skillsVersion: string;
  /** Skills already chosen (the `install` command): the tree is skipped. */
  initialIds?: string[];
  /** Starting order and official filter of the tree (`--sort`, `--official`). */
  sort?: SortOrder;
  official?: boolean;
  /** Detects what is installed in these scopes, to pre-tick it in the tree. */
  loadInstalled?: (scopes: Scope[]) => Promise<TreeData>;
  /** Summary of the previous run, shown above the tree. */
  notice?: string;
  /** Shared by the successive trees of one session: open groups and focused row. */
  treeMemory?: TreeMemory;
  /** `owner/repo@name` (lower case) of the installed skills with a newer version; checked in the background. */
  findUpdates?: () => Promise<Set<string>>;
  onDone: (result: WizardResult | null) => void;
}

type Step = 'loading' | 'tree' | 'scope' | 'agents' | 'method' | 'confirm';
const ORDER: Step[] = ['loading', 'tree', 'scope', 'agents', 'method', 'confirm'];
const STEP_OF: Record<Step, StepId> = {
  loading: 'select',
  tree: 'select',
  scope: 'scope',
  agents: 'agents',
  method: 'method',
  confirm: 'confirm',
};
/** The big logo needs about this many rows on top of the step content. */
const BANNER_MIN_ROWS = 26;

/** The skills CLI only asks for a method when agents use distinct directories. */
function needsMethod(agents: string[]): boolean {
  if (agents.includes('*')) return true;
  return new Set(agents.map((a) => getAgent(a)?.projectDir)).size > 1;
}

interface Answers {
  hasTree: boolean;
  installs: number;
  agents?: string[];
}

/** First step after `from` (or the very first one) that still needs an answer. */
function nextStep(from: Step | undefined, preset: AppProps['preset'], a: Answers): Step {
  for (const s of ORDER.slice(from ? ORDER.indexOf(from) + 1 : 0)) {
    if ((s === 'loading' || s === 'tree') && a.hasTree) return s;
    // Scope, agents and method only matter for skills to install, not for removals.
    if (s === 'scope' && !preset.scope && a.installs > 0) return s;
    if (s === 'agents' && !preset.agents && a.installs > 0) return s;
    if (s === 'method' && !preset.method && a.installs > 0 && a.agents && needsMethod(a.agents)) return s;
  }
  return 'confirm';
}

export function App(props: AppProps) {
  const { themes, skills, preset, defaults, detectedAgents = [], skillsVersion, initialIds, loadInstalled, sort, official, notice, treeMemory, findUpdates, onDone } = props;
  const m = t();
  const { exit } = useApp();
  const { rows } = useTerminalSize();
  const hasTree = !initialIds;
  const [ids, setIds] = useState<string[]>(initialIds ?? []);
  const [removals, setRemovals] = useState<Removal[]>([]);
  const [updates, setUpdates] = useState<Update[]>([]);
  const [outdated, setOutdated] = useState<Set<string>>(new Set());
  const [agents, setAgents] = useState<string[] | undefined>(preset.agents);
  const [scope, setScope] = useState<Scope | undefined>(preset.scope);
  const [method, setMethod] = useState<InstallMethod | undefined>(preset.method);
  const [tree, setTree] = useState<TreeData>({ skills, installed: new Map() });
  const [error, setError] = useState<string>();
  const answers = (over: Partial<Answers> = {}): Answers => ({ hasTree, installs: ids.length, agents, ...over });
  const [step, setStep] = useState<Step>(() => nextStep(undefined, preset, answers()));
  /** Steps shown so far, for going back; leaving the first one quits. */
  const [history, setHistory] = useState<Step[]>([]);
  /** Installed skills are read in the scope given as a flag, else in both. */
  const readScopes = preset.scope ? [preset.scope] : SCOPES;

  const finish = (result: WizardResult | null) => {
    onDone(result);
    exit();
  };
  const next = (from: Step, over?: Partial<Answers>) => {
    if (from !== 'loading') setHistory((h) => [...h, from]);
    setStep(nextStep(from, preset, answers(over)));
  };
  const back = () => {
    const previous = history.at(-1);
    if (!previous) return finish(null);
    setHistory((h) => h.slice(0, -1));
    setStep(previous);
  };

  // Detects installed skills once the scope is known, then opens the tree.
  useEffect(() => {
    if (step !== 'loading') return;
    if (!loadInstalled) {
      setStep('tree');
      return;
    }
    let live = true;
    loadInstalled(readScopes)
      .then((data) => {
        if (!live) return;
        setTree(data);
        next('loading');
      })
      .catch((err: unknown) => {
        if (!live) return;
        setError(m.detectFailed(err instanceof Error ? err.message : String(err)));
        next('loading');
      });
    return () => {
      live = false;
    };
  }, [step]);

  // Asks GitHub for newer versions once the tree is shown, without holding it up.
  useEffect(() => {
    if (step !== 'tree' || !findUpdates || !tree.installed.size) return;
    let live = true;
    findUpdates()
      .then((found) => {
        if (!live) return;
        const global = [...tree.installed].filter(([, e]) => e.scopes.includes('global'));
        setOutdated(new Set(global.map(([id]) => id).filter((id) => found.has(id.toLowerCase()))));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [step === 'tree', tree]);

  /** Every screen: header with the steps, the logo on the first ones, then the content. */
  const screen = (content: ReactNode) => (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      {step !== 'tree' && history.length === 0 && rows >= BANNER_MIN_ROWS && <Banner />}
      <Header step={STEP_OF[step]} />
      {content}
    </Box>
  );

  if (step === 'loading') {
    return screen(<Text color={PALETTE.gold}>{m.loading(scopesLabel(readScopes))}</Text>);
  }

  if (step === 'tree') {
    const installedIds = [...tree.installed.keys()];
    const removedIds = new Set(installedIds.filter((id) => removals.some((r) => r.name === tree.installed.get(id)!.name)));
    return screen(
      <Box flexDirection="column">
        {error && <Text color={PALETTE.danger}>{error}</Text>}
        {notice && <Text>{notice}</Text>}
        <TreeSelect
          themes={tree.installed.size ? [INSTALLED_THEME, ...themes] : themes}
          skills={tree.skills}
          installed={tree.installed}
          scopes={loadInstalled ? readScopes : undefined}
          initialSort={sort}
          initialOfficial={official}
          memory={treeMemory}
          updates={outdated}
          initialSelected={[...ids, ...installedIds.filter((id) => !removedIds.has(id))]}
          onSubmit={(sel, update = []) => {
            const chosen = new Set(sel);
            const toInstall = sel.filter((id) => !tree.installed.has(id));
            const toRemove = installedIds.filter((id) => !chosen.has(id)).map((id) => tree.installed.get(id)!);
            if (!toInstall.length && !toRemove.length && !update.length) return finish(null);
            setIds(toInstall);
            setUpdates(update.map((id) => ({ id, agents: tree.installed.get(id)?.agents ?? [] })));
            // An unticked skill is uninstalled from every scope it was found in.
            setRemovals(toRemove.map((e) => ({ name: e.name, scopes: [...e.scopes] })));
            next('tree', { installs: toInstall.length });
          }}
          onCancel={() => finish(null)}
        />
      </Box>,
    );
  }

  if (step === 'scope') {
    return screen(
      <ListSelect<Scope>
        key="scope"
        title={m.scope.title}
        initial={[scope ?? defaults.scope]}
        items={[
          { value: 'project', label: m.scope.project, hint: m.scope.projectHint(process.cwd()) },
          { value: 'global', label: m.scope.global, hint: m.scope.globalHint },
        ]}
        onSubmit={([value]) => {
          setScope(value);
          next('scope');
        }}
        onCancel={back}
      />,
    );
  }

  if (step === 'agents') {
    const detected = new Set(detectedAgents);
    return screen(
      <ListSelect
        key="agents"
        title={m.agents.title}
        multiple
        initial={agents ?? defaults.agents}
        items={[
          { value: '*', label: m.agents.all, hint: `${AGENTS.length}` },
          ...AGENTS.map((a) => ({
            value: a.id,
            label: a.displayName,
            badge: detected.has(a.id) ? m.agents.detected : undefined,
            hint: `${a.id} · ${a.projectDir}`,
          })),
        ]}
        onSubmit={(values) => {
          const chosen = values.includes('*') ? ['*'] : values;
          setAgents(chosen);
          next('agents', { agents: chosen });
        }}
        onCancel={back}
      />,
    );
  }

  if (step === 'method') {
    return screen(
      <ListSelect<InstallMethod>
        key="method"
        title={m.method.title}
        initial={[method ?? defaults.method]}
        items={[
          { value: 'symlink', label: m.method.symlink, hint: m.method.symlinkHint },
          { value: 'copy', label: m.method.copy, hint: m.method.copyHint },
        ]}
        onSubmit={([value]) => {
          setMethod(value);
          next('method');
        }}
        onCancel={back}
      />,
    );
  }

  const options: InstallOptions = {
    agents: agents ?? defaults.agents,
    scope: scope ?? defaults.scope,
    method: method ?? defaults.method,
    skillsVersion,
  };
  return screen(
    <Confirm
      ids={ids}
      remove={removals}
      update={updates}
      // One folder per name in a scope: what is installed there, minus what this run uninstalls from it.
      collisions={nameCollisions(
        ids,
        [...tree.installed]
          .filter(([, e]) => e.scopes.includes(options.scope) && !removals.some((r) => r.name === e.name && r.scopes.includes(options.scope)))
          .map(([id]) => id),
      )}
      options={options}
      onConfirm={() => finish({ ids, remove: removals, update: updates, options })}
      onBack={back}
    />,
  );
}

interface ConfirmProps {
  ids: string[];
  remove: Removal[];
  update: Update[];
  collisions: Collision[];
  options: InstallOptions;
  onConfirm: () => void;
  onBack: () => void;
}

function Confirm({ ids, remove, update, collisions, options, onConfirm, onBack }: ConfirmProps) {
  const m = t();
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (key.return || input === 'y') onConfirm();
    else if (key.escape || input === 'n') onBack();
  });
  const removeCommands = planRemovals(remove, options.skillsVersion);
  const addCommands = [...(ids.length ? planInstall(ids, options) : []), ...planUpdates(update, options)];
  const installCommands = ids.length ? planInstall(ids, options) : [];
  const row = (label: string, value: string) => (
    <Text>
      <Text dimColor>{padEnd(label, 10)}</Text>
      {value}
    </Text>
  );
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{m.confirm.title}</Text>
      {remove.length > 0 && (
        <Panel color={PALETTE.danger} title={`− ${m.confirm.remove(remove.length)}`}>
          <Text wrap="wrap">{remove.map((r) => `${r.name} (${scopesLabel(r.scopes)})`).join('  ·  ')}</Text>
        </Panel>
      )}
      {ids.length > 0 && (
        <Panel color={PALETTE.success} title={`+ ${m.confirm.install(ids.length, installCommands.length)}`}>
          {installCommands.map((c) => (
            <Text key={c.source} wrap="truncate-end">
              <Text dimColor>{c.source}</Text>
              {`  ${c.skills.join(', ')}`}
            </Text>
          ))}
        </Panel>
      )}
      {collisions.length > 0 && (
        <Panel color={PALETTE.gold} title={`⚠ ${m.confirm.collisions(collisions.length)}`}>
          {collisions.map((c) => (
            <Text key={c.incoming} wrap="wrap">
              {m.confirm.replaces(c.incoming, c.replaced, c.installed)}
            </Text>
          ))}
        </Panel>
      )}
      {update.length > 0 && (
        <Panel color={PALETTE.gold} title={`↑ ${m.confirm.update(update.length)}`}>
          <Text wrap="wrap">{update.map((u) => u.id).join('  ·  ')}</Text>
        </Panel>
      )}
      <Box flexDirection="column">
        {ids.length > 0 && row(m.confirm.scope, options.scope === 'global' ? m.scope.global : m.scope.project)}
        {ids.length > 0 && row(m.confirm.agents, options.agents.join(', '))}
        {ids.length > 0 && row(m.confirm.method, options.method === 'copy' ? m.method.copy : m.method.symlink)}
      </Box>
      <Box flexDirection="column">
        <Text dimColor>{m.confirm.commands}</Text>
        {[...removeCommands, ...addCommands].map((c, i) => (
          <Text key={i} color={PALETTE.muted} wrap="truncate-end">
            {`  $ ${formatCommand(c)}`}
          </Text>
        ))}
      </Box>
      <Hints
        items={[
          [m.keyNames.enter, m.keys.apply, onConfirm],
          [m.keyNames.esc, m.keys.back, onBack],
        ]}
      />
    </Box>
  );
}
