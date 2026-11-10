import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useState, type ReactNode } from 'react';
import { AGENTS, getAgent } from '../agents.js';
import { INSTALLED_THEME, type TreeData } from '../catalog/installed.js';
import type { SortOrder } from '../catalog/query.js';
import { t } from '../i18n/index.js';
import { nameCollisions, type Collision } from '../install/collisions.js';
import { riskNote, riskWhere } from '../risks.js';
import { auditSkills, auditTarget, failsAudit, withLookalikes, type AuditResult } from '../audit.js';
import { formatCommand, planInstall, planRemovals, planUpdates, type Update } from '../install/plan.js';
import { SCOPES, type InstallMethod, type InstallOptions, type Removal, type Scope, type Skill, type Theme } from '../types.js';
import { ACCENT, Banner, bannerLines, Header, Hints, Panel, ReservedRows, useTerminalSize, type Hint, type StepId } from './Layout.js';
import { ListSelect } from './ListSelect.js';
import { isMouseInput } from './mouse.js';
import { padEnd } from './width.js';
import { scopesLabel, TreeSelect, type PackOps, type TreeAction, type TreeMemory } from './TreeSelect.js';
import { isBundledPack, packThemes } from '../catalog/packs.js';
import { TERMINAL_PALETTE as PALETTE } from './palette.js';
import type { ScopedUpdateCheck } from '../install/updates.js';

export interface WizardResult {
  /** Skills to install (`owner/repo@name`). */
  ids: string[];
  /** Installed skills to uninstall, from every scope they are in. */
  remove: Removal[];
  /** Installed skills to reinstall at their latest version. */
  update: Update[];
  options: InstallOptions;
  /** A pack, profile or backup key pressed in the tree: the caller does it, then shows the tree again. */
  action?: TreeAction;
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
  search?: string;
  official?: boolean;
  /** Detects what is installed in these scopes, to pre-tick it in the tree. */
  loadInstalled?: (scopes: Scope[]) => Promise<TreeData>;
  /** Summary of the previous run, shown above the tree. */
  notice?: string;
  /** Warnings about this machine (heavy context loads…): one ⚠ count in the tree, listed with `!`. */
  warnings?: string[];
  /** Shared by the successive trees of one session: open groups and focused row. */
  treeMemory?: TreeMemory;
  /** `owner/repo@name` (lower case) of the installed skills with a newer version, per scope; checked in the background. */
  findUpdates?: (scopes: Scope[]) => Promise<ScopedUpdateCheck>;
  /** Run the security audit on the review screen (on unless turned off). */
  audit?: boolean;
  /** Reads a skill's SKILL.md for the audit; replaced in tests. */
  readSkill?: (s: Pick<Skill, 'id' | 'source' | 'name' | 'path'>) => Promise<string>;
  onDone: (result: WizardResult | null) => void;
  /** Turns on the tree's pack, profile and backup keys; the ids of the packs that can be edited. */
  personalPacks?: Set<string>;
  /** Pack and backup operations for the tree's N, E, D, P and B keys. */
  packOps?: PackOps;
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
/** Rows the tree keeps for itself under the logo; below that, the logo is left out on the tree. */
const TREE_MIN_ROWS = 30;

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
  const { themes, skills, preset, defaults, detectedAgents = [], skillsVersion, initialIds, loadInstalled, sort, search, official, notice, treeMemory, findUpdates, audit = true, readSkill, onDone, personalPacks: initialPersonal, packOps, warnings = [] } = props;
  // Packs change while the tree is open (N, E, D): their themes are rebuilt here, in place.
  const [themeList, setThemeList] = useState(themes);
  const [personalPacks, setPersonalPacks] = useState(initialPersonal);
  // After a restore: what it did, above the tree read again.
  const [restoredNotice, setRestoredNotice] = useState<string>();
  const m = t();
  const { exit } = useApp();
  const { rows, columns } = useTerminalSize();
  const hasTree = !initialIds;
  const [ids, setIds] = useState<string[]>(initialIds ?? []);
  const [removals, setRemovals] = useState<Removal[]>([]);
  const [updates, setUpdates] = useState<Update[]>([]);
  const [outdated, setOutdated] = useState<Set<string>>(new Set());
  // The scopes in which each outdated skill has a newer version.
  const [outdatedScopes, setOutdatedScopes] = useState<Map<string, Scope[]>>(new Map());
  const [unchecked, setUnchecked] = useState(0);
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
        // Packs changed in this session (N, E, D) keep their themes when what is installed is read again.
        setTree(packOps ? { ...data, skills: packThemes(data.skills, themeList, packOps.list()).skills } : data);
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
    const scopes = [...new Set([...tree.installed.values()].flatMap((e) => e.scopes))];
    findUpdates(scopes)
      .then((found) => {
        if (!live) return;
        const byId = new Map<string, Scope[]>();
        for (const [id, e] of tree.installed) {
          const inScopes = e.scopes.filter((sc) => found.outdated[sc].has(id.toLowerCase()));
          if (inScopes.length) byId.set(id, inScopes);
        }
        setOutdatedScopes(byId);
        setOutdated(new Set(byId.keys()));
        setUnchecked(found.unchecked.length);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [step === 'tree', tree]);

  /**
   * Every screen: the logo when the terminal is tall enough (the tree needs more room under it),
   * the header with the steps, then the content, which sizes itself without the rows above it.
   */
  const logoRows = bannerLines(columns);
  const showBanner = rows >= (step === 'tree' ? logoRows + TREE_MIN_ROWS : BANNER_MIN_ROWS);
  const screen = (content: ReactNode, above = 0) => (
    <Box flexDirection="column" paddingX={1} paddingTop={1}>
      {showBanner && <Banner />}
      <Header step={STEP_OF[step]} />
      <ReservedRows.Provider value={(showBanner ? logoRows : 0) + above}>{content}</ReservedRows.Provider>
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
        {(restoredNotice ?? notice) && <Text color={restoredNotice ? PALETTE.pink : undefined}>{restoredNotice ?? notice}</Text>}
        <TreeSelect
          warnings={[...warnings, ...(unchecked > 0 ? [t().cli.updatesUnchecked(unchecked)] : [])]}
          themes={tree.installed.size ? [INSTALLED_THEME, ...themeList] : themeList}
          skills={tree.skills}
          installed={tree.installed}
          scopes={loadInstalled ? readScopes : undefined}
          initialSort={sort}
          initialSearch={search}
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
            setUpdates(update.flatMap((id) => {
              const e = tree.installed.get(id);
              // One reinstall per scope where it is outdated, for the agents of that scope.
              return (outdatedScopes.get(id) ?? ['global' as Scope]).map((scope) => ({ id, scope, agents: e?.agentsByScope?.[scope] ?? e?.agents ?? [] }));
            }));
            // An unticked skill is uninstalled from every scope it was found in.
            setRemovals(toRemove.map((e) => ({ name: e.name, scopes: [...e.scopes] })));
            next('tree', { installs: toInstall.length });
          }}
          onCancel={() => finish(null)}
          personalPacks={personalPacks}
          packOps={packOps}
          onAction={(action) => {
            if (action.kind === 'packsChanged' && packOps) {
              const packs = packOps.list();
              const rebuilt = packThemes(tree.skills, themeList, packs);
              setTree({ ...tree, skills: rebuilt.skills });
              setThemeList(rebuilt.themes);
              setPersonalPacks(new Set(packs.filter((p) => !isBundledPack(p.id)).map((p) => p.id)));
            } else if (action.kind === 'restored') {
              // What is installed changed: read it again, then back to the tree.
              setRestoredNotice(action.message);
              setStep('loading');
            } else if (action.kind === 'profile') {
              finish({ ids: [], remove: [], update: [], options: { ...defaults, skillsVersion }, action });
            }
          }}
        />
      </Box>,
      (error ? 1 : 0) + ((restoredNotice ?? notice) ? (restoredNotice ?? notice)!.split('\n').length : 0),
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

  const targets = new Map(tree.skills.map((sk) => [sk.id.toLowerCase(), sk]));
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
      audit={audit}
      targets={targets}
      readSkill={readSkill}
      // Nothing left once the audit left skills out (and nothing to remove): nothing to run.
      onConfirm={(kept, keptUpdates) =>
        finish(kept.length || keptUpdates.length || removals.length ? { ids: kept, remove: removals, update: keptUpdates, options } : null)
      }
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
  /** Run the security audit on what will be installed or updated. */
  audit: boolean;
  /** Catalog skills by lower-case id, for their SKILL.md path. */
  targets: Map<string, Skill>;
  readSkill?: (s: Pick<Skill, 'id' | 'source' | 'name' | 'path'>) => Promise<string>;
  /** What to install and update, without the skills left out after the audit. */
  onConfirm: (ids: string[], update: Update[]) => void;
  onBack: () => void;
}

function Confirm({ ids, remove, update, collisions, options, audit, targets, readSkill, onConfirm, onBack }: ConfirmProps) {
  const m = t();
  const audited = [...new Set([...ids, ...update.map((u) => u.id)])];
  const [results, setResults] = useState<AuditResult[] | undefined>(audit && audited.length ? undefined : []);
  // Skills that fail the audit are left out, unless the user ticks them here.
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    if (results) return;
    let live = true;
    void auditSkills(audited.map((id) => auditTarget(id, targets)), readSkill).then((r) => live && setResults(withLookalikes(r, [...targets.values()])));
    return () => {
      live = false;
    };
  }, []);
  const failing = (results ?? []).filter(failsAudit);
  const left = new Set(failing.map((r) => r.id).filter((id) => !keep.has(id)));
  const keptIds = ids.filter((id) => !left.has(id));
  const keptUpdates = update.filter((u) => !left.has(u.id));
  const ready = results !== undefined;
  const confirm = () => ready && onConfirm(keptIds, keptUpdates);
  const toggleKeep = (id: string) => {
    const next = new Set(keep);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setKeep(next);
  };
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (key.escape || input === 'n') onBack();
    else if (!ready) return;
    else if (key.upArrow) setCursor(Math.max(0, cursor - 1));
    else if (key.downArrow) setCursor(Math.min(failing.length - 1, cursor + 1));
    else if (input === ' ' && failing[cursor]) toggleKeep(failing[cursor]!.id);
    else if (key.return || input === 'y') confirm();
  });
  const removeCommands = planRemovals(remove, options.skillsVersion);
  const addCommands = [...(keptIds.length ? planInstall(keptIds, options) : []), ...planUpdates(keptUpdates, options)];
  const installCommands = keptIds.length ? planInstall(keptIds, options) : [];
  const warned = (results ?? []).filter((r) => !failsAudit(r) && (r.error || r.risks.some((x) => x.level === 'medium')));
  const passed = (results ?? []).filter((r) => !r.error && !r.risks.some((x) => x.level !== 'info')).length;
  const riskLine = (r: AuditResult, level: 'high' | 'medium') =>
    r.risks.filter((x) => x.level === level).slice(0, 2).map((x) => (
      <Text key={x.rule} color={level === 'high' ? PALETTE.danger : PALETTE.gold} wrap="truncate-end">
        {`      ${m.tree.riskLevels[x.level]} · ${m.tree.risks[x.rule]}${riskNote(x)}  `}
        <Text dimColor>{riskWhere(x)}</Text>
      </Text>
    ));
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
      {!audit && audited.length > 0 && <Text dimColor>{`🛡 ${m.confirm.auditOff}`}</Text>}
      {audit && !ready && <Text color={PALETTE.gold}>{`🛡 ${m.confirm.auditing(audited.length)}`}</Text>}
      {ready && failing.length > 0 && (
        <Panel color={PALETTE.danger} title={`🛡 ${m.confirm.auditFailed(failing.length)}`}>
          {failing.map((r, i) => (
            <Box key={r.id} flexDirection="column">
              <Text wrap="truncate-end">
                <Text color={ACCENT}>{i === cursor ? '❯ ' : '  '}</Text>
                <Text color={keep.has(r.id) ? PALETTE.danger : PALETTE.muted}>{keep.has(r.id) ? '◉ ' : '○ '}</Text>
                <Text bold={i === cursor}>{r.id}</Text>
                <Text dimColor>{`  ${keep.has(r.id) ? m.confirm.auditKept : m.confirm.auditLeftOut}`}</Text>
              </Text>
              {riskLine(r, 'high')}
            </Box>
          ))}
          <Text dimColor>{m.confirm.auditHint}</Text>
        </Panel>
      )}
      {ready && warned.length > 0 && (
        <Box flexDirection="column">
          {warned.map((r) => (
            <Box key={r.id} flexDirection="column">
              <Text color={PALETTE.gold} wrap="truncate-end">{r.error ? `? ${r.id}  ${m.confirm.auditUnread}` : `⚠ ${r.id}`}</Text>
              {riskLine(r, 'medium')}
            </Box>
          ))}
        </Box>
      )}
      {ready && audit && passed > 0 && <Text color={PALETTE.success}>{`🛡 ✓ ${m.confirm.auditPassed(passed)}`}</Text>}
      {keptIds.length > 0 && (
        <Panel color={PALETTE.success} title={`+ ${m.confirm.install(keptIds.length, installCommands.length)}`}>
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
      {keptUpdates.length > 0 && (
        <Panel color={PALETTE.gold} title={`↑ ${m.confirm.update(keptUpdates.length)}`}>
          <Text wrap="wrap">{keptUpdates.map((u) => `${u.id} (${u.scope === 'project' ? m.scope.project : m.scope.global})`).join('  ·  ')}</Text>
        </Panel>
      )}
      <Box flexDirection="column">
        {keptIds.length > 0 && row(m.confirm.scope, options.scope === 'global' ? m.scope.global : m.scope.project)}
        {keptIds.length > 0 && row(m.confirm.agents, options.agents.join(', '))}
        {keptIds.length > 0 && row(m.confirm.method, options.method === 'copy' ? m.method.copy : m.method.symlink)}
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
          ...(failing.length ? [['↑↓', m.keys.move] as Hint, [m.keyNames.space, m.confirm.auditToggle] as Hint] : []),
          [m.keyNames.enter, m.keys.apply, ready ? confirm : undefined],
          [m.keyNames.esc, m.keys.back, onBack],
        ]}
      />
    </Box>
  );
}
