import { Box, Text, useInput } from 'ink';
import { useMemo, useRef, useState } from 'react';
import { groupByTheme, haystack, popularityLabel, SORT_ORDERS, sortSkills, type SortOrder } from '../catalog/query.js';
import { githubUrl, openGitHub } from '../github.js';
import { formatNumber, t, themeLabel } from '../i18n/index.js';
import type { InstalledEntry } from '../catalog/installed.js';
import type { Scope, Skill, Theme } from '../types.js';
import { ACCENT, BOX, Hints, Panel, useTerminalSize, type Hint } from './Layout.js';
import { isMouseInput, useListMouse } from './mouse.js';
import { TERMINAL_PALETTE as PALETTE } from './palette.js';
import { fit, padStart, width } from './width.js';

type Row =
  | { kind: 'theme'; theme: Theme; skills: Skill[]; expanded: boolean }
  /** A recommended repository, under the Recommended theme. */
  | { kind: 'repo'; key: string; source: string; reason: string; skills: Skill[]; expanded: boolean; themeId: string }
  /** `parent` is the key of the repository row the skill sits under, if any. */
  | { kind: 'skill'; skill: Skill; themeId: string; parent?: string };

interface ViewCache {
  skills: Skill[];
  themes: Theme[];
  sort: SortOrder;
  officialOnly: boolean;
  filter: string;
  sorted: Skill[];
  visible: Skill[];
  groups: ReturnType<typeof groupByTheme>;
}

/** What the tree leaves behind when it submits, so that the next one opens where this one was. */
export interface TreeMemory {
  expanded?: Set<string>;
  /** Key of the focused row. */
  focus?: string;
}

/** Stable across renders and runs: the same skill, repository or theme keeps its key. */
function rowKey(r: Row): string {
  if (r.kind === 'theme') return `t:${r.theme.id}`;
  if (r.kind === 'repo') return `r:${r.key}`;
  return `s:${r.themeId}:${r.skill.id}`;
}

export interface TreeSelectProps {
  themes: Theme[];
  skills: Skill[];
  initialSelected?: string[];
  /** Installed skill ids: ticked at start, unticking one means uninstalling it (from every scope). */
  installed?: Map<string, InstalledEntry>;
  /** Scopes read for installed skills, shown in the status line. */
  scopes?: Scope[];
  /** Starting order, changed with `s`. */
  initialSort?: SortOrder;
  /** Start with only official skills, toggled with `o`. */
  initialOfficial?: boolean;
  onSubmit: (ids: string[]) => void;
  onCancel: () => void;
  /** Opens the focused skill's validated GitHub repository. */
  onOpenGitHub?: (skill: Skill) => void;
  /** Read at start and written on submit: the open groups and the focused row. */
  memory?: TreeMemory;
}

/** Lines used around the list: header, status, search, details panel, hints (may wrap). */
const CHROME_LINES = 16;
/** Lines moved by one wheel notch. */
const WHEEL_STEP = 3;
/** Clicks up to this screen column on a theme row hit its checkbox (padding, pointer, arrow, box). */
const THEME_BOX_COLUMN = 7;
/** Marks official skills in the list and the details panel. */
const OFFICIAL_MARK = '◆';
const RECOMMENDED_MARK = '★';
const RECOMMENDED = 'recommended';
const EMPTY_INSTALLED = new Map<string, InstalledEntry>();

/** Recommended skills by repository, in the curated order; each keeps the list's order. */
function byRepository(skills: Skill[]): { key: string; skills: Skill[] }[] {
  const repos = new Map<string, Skill[]>();
  for (const s of skills) {
    const key = `${RECOMMENDED}/${s.source.toLowerCase()}`;
    repos.set(key, [...(repos.get(key) ?? []), s]);
  }
  const order = (list: Skill[]) => list[0]!.recommendation?.order ?? 0;
  return [...repos].map(([key, list]) => ({ key, skills: list })).sort((a, b) => order(a.skills) - order(b.skills));
}

/** Theme headers, each followed by its skills when open (always open during a search). */
function buildRows(groups: { theme: Theme; skills: Skill[] }[], expanded: Set<string>, filter: string): Row[] {
  const out: Row[] = [];
  for (const g of groups) {
    const isOpen = filter !== '' || expanded.has(g.theme.id);
    out.push({ kind: 'theme', theme: g.theme, skills: g.skills, expanded: isOpen });
    if (!isOpen) continue;
    if (g.theme.id !== RECOMMENDED) {
      for (const skill of g.skills) out.push({ kind: 'skill', skill, themeId: g.theme.id });
      continue;
    }
    for (const repo of byRepository(g.skills)) {
      const open = filter !== '' || expanded.has(repo.key);
      const first = repo.skills[0]!;
      out.push({ kind: 'repo', key: repo.key, source: first.source, reason: first.recommendation?.reason ?? '', skills: repo.skills, expanded: open, themeId: g.theme.id });
      if (open) for (const skill of repo.skills) out.push({ kind: 'skill', skill, themeId: g.theme.id, parent: repo.key });
    }
  }
  return out;
}

/** Long popularity for the details panel: "924,211 installs". */
function popularityLong(s: Skill): string {
  const m = t().tree;
  if (s.installs) return `${formatNumber(s.installs)} ${m.installs}`;
  if (s.stars) return `${formatNumber(s.stars)} ${m.stars}`;
  return s.rank !== undefined ? `${m.rank} #${formatNumber(s.rank)}` : '';
}

/** "project", "global" or "project + global". */
export function scopesLabel(scopes: Scope[]): string {
  return scopes.map((sc) => t().tree.where[sc]).join(' + ');
}

export function TreeSelect({
  themes,
  skills,
  initialSelected = [],
  installed = EMPTY_INSTALLED,
  scopes,
  initialSort = 'installs',
  initialOfficial = false,
  onSubmit,
  onCancel,
  onOpenGitHub = openGitHub,
  memory,
}: TreeSelectProps) {
  const m = t();
  const { columns, rows: termRows } = useTerminalSize();
  const [expanded, setExpandedState] = useState<Set<string>>(() => new Set(memory?.expanded));
  const [selected, setSelectedState] = useState<Set<string>>(new Set(initialSelected));
  const [cursor, setCursorState] = useState(0);
  const [filter, setFilterState] = useState('');
  const [editingFilter, setEditingFilterState] = useState(false);
  const [sort, setSort] = useState<SortOrder>(initialSort);
  const [officialOnly, setOfficialOnly] = useState(initialOfficial);
  // Keys can arrive faster than renders (held arrows, pasted input, a slow terminal): the
  // handlers read and write these through a ref, so that each key sees the previous one.
  const live = useRef({ expanded, selected, cursor, filter, editingFilter, sort, officialOnly });
  const setExpanded = (next: Set<string>) => {
    live.current.expanded = next;
    setExpandedState(next);
  };
  const setSelected = (next: Set<string>) => {
    live.current.selected = next;
    setSelectedState(next);
  };
  const setCursor = (next: number) => {
    live.current.cursor = next;
    setCursorState(next);
  };
  const setFilter = (next: string) => {
    live.current.filter = next;
    setFilterState(next);
  };
  const setEditingFilter = (next: boolean) => {
    live.current.editingFilter = next;
    setEditingFilterState(next);
  };

  const texts = useMemo(() => new Map(skills.map((s) => [s.id, haystack(s)])), [skills]);
  const viewCache = useRef<ViewCache | undefined>(undefined);
  // Render and input handlers share the query cache. A sort or filter key immediately changes
  // the view used by subsequent keys, even when React has not rendered the new state yet.
  const getView = (sort: SortOrder, officialOnly: boolean, filter: string): ViewCache => {
    const cached = viewCache.current;
    const sameSort = cached !== undefined && cached.skills === skills && cached.sort === sort;
    const sameFilter = sameSort && cached.officialOnly === officialOnly && cached.filter === filter;
    if (sameFilter && cached.themes === themes) return cached;
    const sorted = sameSort ? cached.sorted : sortSkills(skills, sort);
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const visible = sameFilter ? cached.visible : sorted.filter(
      (s) => (!officialOnly || s.official) && terms.every((term) => texts.get(s.id)!.includes(term)),
    );
    const groups = groupByTheme(themes, visible);
    const view = { skills, themes, sort, officialOnly, filter, sorted, visible, groups };
    viewCache.current = view;
    return view;
  };
  const { visible, groups } = getView(sort, officialOnly, filter);

  // Reuse the flattened list between navigation events. Expansion still updates synchronously,
  // so a second key arriving before React renders sees the newly opened or closed theme.
  const rowCache = useRef<{ groups: typeof groups; expanded: Set<string>; filter: string; rows: Row[] } | undefined>(undefined);
  const getRows = (open: Set<string>, groups: ViewCache['groups'], filter: string) => {
    const cached = rowCache.current;
    if (cached?.groups === groups && cached.expanded === open && cached.filter === filter) return cached.rows;
    const rows = buildRows(groups, open, filter);
    rowCache.current = { groups, expanded: open, filter, rows };
    return rows;
  };
  const rows = getRows(expanded, groups, filter);
  // Back from a run: focus the row that was focused, wherever the list now puts it.
  const restored = useRef(false);
  if (!restored.current) {
    restored.current = true;
    const index = memory?.focus ? rows.findIndex((r) => rowKey(r) === memory.focus) : -1;
    if (index > 0) {
      live.current.cursor = index;
      setCursorState(index);
    }
  }

  const { toInstall, toRemove, checkedByTheme } = useMemo(() => {
    let toInstall = 0;
    let toRemove = 0;
    for (const id of selected) if (!installed.has(id)) toInstall++;
    for (const id of installed.keys()) if (!selected.has(id)) toRemove++;
    const checkedByTheme = new Map(groups.map((g) => [g.theme.id, g.skills.reduce((n, s) => n + Number(selected.has(s.id)), 0)]));
    return { toInstall, toRemove, checkedByTheme };
  }, [selected, installed, groups]);

  const height = Math.max(5, termRows - CHROME_LINES);
  const current = Math.min(cursor, Math.max(0, rows.length - 1));
  const top = Math.max(0, Math.min(current - Math.floor(height / 2), rows.length - height));
  const row = rows[current];

  // Column widths of skill rows: cursor+indent+box (8), name, source, status, popularity.
  const popW = 8;
  const statusW = Math.max(width(scopesLabel(['project', 'global'])), width(m.tree.toRemove)) + 3;
  const nameW = Math.max(18, Math.min(40, Math.floor(columns * 0.3)));
  // The screen has a 1-column padding on each side.
  const sourceW = Math.max(0, columns - 2 - 8 - nameW - 2 - statusW - 2 - popW - 1);

  /** Rows and cursor as the keys typed so far left them, even before the next render. */
  const liveView = () => getView(live.current.sort, live.current.officialOnly, live.current.filter);
  const liveRows = () => getRows(live.current.expanded, liveView().groups, live.current.filter);
  const liveCurrent = (list: Row[]) => Math.min(live.current.cursor, Math.max(0, list.length - 1));
  const move = (delta: number) => {
    const list = liveRows();
    setCursor(Math.max(0, Math.min(list.length - 1, liveCurrent(list) + delta)));
  };
  const setOpen = (themeId: string, open: boolean) => {
    if (live.current.expanded.has(themeId) === open) return;
    const next = new Set(live.current.expanded);
    if (open) next.add(themeId);
    else next.delete(themeId);
    setExpanded(next);
  };
  const toggle = (ids: string[]) => {
    const next = new Set(live.current.selected);
    const allOn = ids.every((id) => next.has(id));
    for (const id of ids) {
      if (allOn) next.delete(id);
      else next.add(id);
    }
    setSelected(next);
  };

  // Actions shared by the keys and the buttons of the hint bar.
  const changes = (sel: Set<string>) =>
    [...sel].some((id) => !installed.has(id)) || [...installed.keys()].some((id) => !sel.has(id));
  const canSubmit = toInstall > 0 || toRemove > 0;
  const submit = () => {
    if (memory) {
      const list = liveRows();
      const focused = list[liveCurrent(list)];
      memory.expanded = live.current.expanded;
      memory.focus = focused && rowKey(focused);
    }
    onSubmit([...live.current.selected]);
  };
  const startSearch = () => setEditingFilter(true);
  const endSearch = () => setEditingFilter(false);
  const clearSearch = () => {
    setFilter('');
    setEditingFilter(false);
    setCursor(0);
  };
  const cycleSort = () => {
    const next = SORT_ORDERS[(SORT_ORDERS.indexOf(live.current.sort) + 1) % SORT_ORDERS.length]!;
    live.current.sort = next;
    setSort(next);
    setCursor(0);
  };
  const toggleOfficial = () => {
    const next = !live.current.officialOnly;
    live.current.officialOnly = next;
    setOfficialOnly(next);
    setCursor(0);
  };
  const toggleAll = () =>
    setExpanded(live.current.expanded.size ? new Set() : new Set(liveView().groups.flatMap((g) =>
      [g.theme.id, ...(g.theme.id === RECOMMENDED ? byRepository(g.skills).map((r) => r.key) : [])])));
  const openFocusedGitHub = () => {
    const list = liveRows();
    const focused = list[liveCurrent(list)];
    if (focused?.kind === 'skill' && githubUrl(focused.skill)) onOpenGitHub(focused.skill);
  };
  const canOpenGitHub = row?.kind === 'skill' && githubUrl(row.skill) !== undefined;

  // Wheel moves the cursor; a click ticks a skill, or opens a theme (ticks it on its checkbox).
  const { ref: listRef, hover } = useListMouse(Math.min(height, rows.length - top), (e) => {
    if (e.kind === 'wheelUp') move(-WHEEL_STEP);
    else if (e.kind === 'wheelDown') move(WHEEL_STEP);
    if (e.kind !== 'click' || e.line < 0 || e.line >= height) return;
    const index = top + e.line;
    const r = rows[index];
    if (!r) return;
    setEditingFilter(false);
    setCursor(index);
    if (r.kind === 'skill') toggle([r.skill.id]);
    else if (e.x <= THEME_BOX_COLUMN + (r.kind === 'repo' ? 2 : 0)) toggle(r.skills.map((s) => s.id));
    else setOpen(r.kind === 'repo' ? r.key : r.theme.id, !r.expanded);
  });

  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (live.current.editingFilter) {
      if (key.return) endSearch();
      else if (key.escape) clearSearch();
      else if (key.backspace || key.delete) setFilter(live.current.filter.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setFilter(live.current.filter + input);
      setCursor(0);
      return;
    }
    const list = liveRows();
    const row = list[liveCurrent(list)];
    if (key.upArrow || input === 'k') move(-1);
    else if (key.downArrow || input === 'j') move(1);
    else if (key.pageUp) move(-height);
    else if (key.pageDown) move(height);
    else if (key.rightArrow && row?.kind === 'theme') setOpen(row.theme.id, true);
    else if (key.rightArrow && row?.kind === 'repo') setOpen(row.key, true);
    else if (key.leftArrow && row?.kind === 'skill' && row.parent) {
      // A skill under a repository closes that repository, not the whole theme.
      const parent = row.parent;
      setOpen(parent, false);
      setCursor(liveRows().findIndex((r) => r.kind === 'repo' && r.key === parent));
    } else if (key.leftArrow && row) {
      const themeId = row.kind === 'theme' ? row.theme.id : row.themeId;
      setOpen(themeId, false);
      setCursor(liveRows().findIndex((r) => r.kind === 'theme' && r.theme.id === themeId));
    } else if (input === ' ' && row) {
      toggle(row.kind === 'skill' ? [row.skill.id] : row.skills.map((s) => s.id));
    } else if (input === '/') startSearch();
    else if (input === 's') cycleSort();
    else if (input === 'o') toggleOfficial();
    else if (input === 'a') toggleAll();
    else if (input === 'g') openFocusedGitHub();
    else if (key.escape && live.current.filter) setFilter('');
    else if (key.return && changes(live.current.selected)) submit();
    else if (key.return && row?.kind === 'theme') setOpen(row.theme.id, !row.expanded);
    else if (key.return && row?.kind === 'repo') setOpen(row.key, !row.expanded);
    else if (input === 'q' || key.escape) onCancel();
  });

  // Buttons do what their key does; continue is only clickable once something changes.
  const hints: Hint[] = editingFilter
    ? [
        [m.keyNames.enter, m.keys.done, endSearch],
        [m.keyNames.esc, m.keys.clear, clearSearch],
      ]
    : [
        [m.keyNames.space, m.keys.toggle],
        ['/', m.keys.search, startSearch],
        ...(filter ? [[m.keyNames.esc, m.keys.clear, clearSearch] as Hint] : []),
        ['a', m.keys.expandAll, toggleAll],
        ['s', m.keys.sort, cycleSort],
        ['o', m.keys.official, toggleOfficial],
        ...(canOpenGitHub ? [['g', m.keys.github, openFocusedGitHub] as Hint] : []),
        [m.keyNames.enter, m.keys.continue, canSubmit ? submit : undefined],
        ['q', m.keys.quit, onCancel],
      ];

  return (
    <Box flexDirection="column">
      {/* Status line: counts on the left, position on the right. */}
      <Box justifyContent="space-between">
        <Text>
          <Text bold>{m.tree.skills(formatNumber(visible.length))}</Text>
          <Text dimColor>{'   '}</Text>
          <Text color={PALETTE.success}>
            {BOX.on} {m.tree.selected(selected.size)}
          </Text>
          {(toInstall > 0 || toRemove > 0) && (
            <Text>
              {'   '}
              <Text color={PALETTE.success}>+{toInstall}</Text> <Text color={PALETTE.danger}>−{toRemove}</Text>
            </Text>
          )}
          {scopes && <Text dimColor>{`   ${m.tree.scope(scopesLabel(scopes))}`}</Text>}
          <Text dimColor>{`   ${m.tree.sortedBy(m.tree.sort[sort])}`}</Text>
          {officialOnly && <Text color={PALETTE.lavender}>{`   ${OFFICIAL_MARK} ${m.tree.officialOnly}`}</Text>}
        </Text>
        <Text dimColor>{rows.length ? m.tree.position(formatNumber(current + 1), formatNumber(rows.length)) : ''}</Text>
      </Box>

      {/* Search line: always reserved so that the list does not jump. */}
      <Text>
        <Text color={editingFilter ? ACCENT : PALETTE.muted}>/ {m.tree.searchLabel}: </Text>
        {filter ? <Text color={PALETTE.gold}>{filter}</Text> : editingFilter ? <Text dimColor>{m.tree.searchPlaceholder}</Text> : null}
        {editingFilter && <Text color={ACCENT}>▌</Text>}
      </Text>

      <Box ref={listRef} flexDirection="column" height={height} marginTop={1}>
        {rows.slice(top, top + height).map((r, i) => {
          const focused = top + i === current;
          // Under the mouse: a lighter pointer and an underlined name, the row a click will hit.
          const hovered = i === hover && !focused;
          const pointer = <Text color={ACCENT}>{focused ? '❯ ' : hovered ? '› ' : '  '}</Text>;
          if (r.kind === 'theme') {
            const n = checkedByTheme.get(r.theme.id) ?? 0;
            const box = n === 0 ? BOX.off : n === r.skills.length ? BOX.on : BOX.some;
            return (
              <Box key={rowKey(r)} justifyContent="space-between">
                <Text wrap="truncate-end">
                  {pointer}
                  <Text dimColor>{r.expanded ? '▾ ' : '▸ '}</Text>
                  <Text color={n ? PALETTE.success : undefined}>{box} </Text>
                  <Text bold underline={hovered} color={focused || hovered ? ACCENT : undefined}>
                    {r.theme.id === 'recommended' && <Text color={PALETTE.gold}>{RECOMMENDED_MARK} </Text>}
                    {themeLabel(r.theme)}
                  </Text>
                </Text>
                <Text>
                  {n > 0 && <Text color={PALETTE.success}>{`${formatNumber(n)} ✓   `}</Text>}
                  <Text dimColor>{padStart(formatNumber(r.skills.length), 7)}</Text>
                </Text>
              </Box>
            );
          }
          if (r.kind === 'repo') {
            const n = r.skills.reduce((k, s) => k + Number(selected.has(s.id)), 0);
            const box = n === 0 ? BOX.off : n === r.skills.length ? BOX.on : BOX.some;
            return (
              <Box key={rowKey(r)} justifyContent="space-between">
                <Text wrap="truncate-end">
                  {pointer}
                  {'  '}
                  <Text dimColor>{r.expanded ? '▾ ' : '▸ '}</Text>
                  <Text color={n ? PALETTE.success : undefined}>{box} </Text>
                  <Text bold underline={hovered} color={focused || hovered ? ACCENT : undefined}>
                    <Text color={PALETTE.gold}>{RECOMMENDED_MARK} </Text>
                    {r.source}
                  </Text>
                </Text>
                <Text>
                  {n > 0 && <Text color={PALETTE.success}>{`${formatNumber(n)} ✓   `}</Text>}
                  <Text dimColor>{padStart(formatNumber(r.skills.length), 7)}</Text>
                </Text>
              </Box>
            );
          }
          const s = r.skill;
          // Under its repository the star is already on the repository row.
          const star = s.recommendation !== undefined && !r.parent;
          const isOn = selected.has(s.id);
          const entry = installed.get(s.id);
          const isInstalled = entry !== undefined;
          const status = entry ? (isOn ? `● ${scopesLabel(entry.scopes)}` : `✗ ${m.tree.toRemove}`) : '';
          return (
            <Text key={rowKey(r)} wrap="truncate-end">
              {pointer}
              {r.parent ? '    ' : '  '}
              <Text color={PALETTE.lavender}>{s.official ? OFFICIAL_MARK : ' '} </Text>
              <Text color={isInstalled && !isOn ? PALETTE.danger : isOn ? PALETTE.success : PALETTE.muted}>{isOn ? BOX.on : BOX.off} </Text>
              <Text bold={focused} underline={hovered} color={focused || hovered ? ACCENT : undefined}>
                {star && <Text color={PALETTE.gold}>{RECOMMENDED_MARK} </Text>}
                {fit(s.name, nameW - (star ? 2 : 0) - (r.parent ? 2 : 0))}
              </Text>
              <Text dimColor>{`  ${fit(s.source, sourceW)}`}</Text>
              <Text color={isInstalled && !isOn ? PALETTE.danger : PALETTE.accent}>{`  ${fit(status, statusW)}`}</Text>
              <Text dimColor>{padStart(popularityLabel(s), popW)}</Text>
            </Text>
          );
        })}
      </Box>

      <Panel>
        {row?.kind === 'skill' ? (
          <>
            <Box justifyContent="space-between">
              <Text wrap="truncate-end">
                <Text bold>{row.skill.recommendation && <Text color={PALETTE.gold}>{RECOMMENDED_MARK} </Text>}{row.skill.name}</Text>
                <Text dimColor>{`  ${row.skill.source}`}</Text>
                {row.skill.official && <Text color={PALETTE.lavender}>{`  ${OFFICIAL_MARK} ${m.tree.official}`}</Text>}
                {installed.has(row.skill.id) && (
                  <Text color={PALETTE.accent}>{`  ● ${m.tree.installedIn(scopesLabel(installed.get(row.skill.id)!.scopes))}`}</Text>
                )}
              </Text>
              <Text dimColor>{popularityLong(row.skill)}</Text>
            </Box>
            <Box height={2} overflow="hidden">
              <Text wrap="wrap">{row.skill.description ?? row.skill.recommendation?.reason ?? m.tree.noDescription}</Text>
            </Box>
          </>
        ) : row?.kind === 'repo' ? (
          <>
            <Text>
              <Text bold><Text color={PALETTE.gold}>{RECOMMENDED_MARK} </Text>{row.source}</Text>
              <Text dimColor>{`  ${m.tree.skills(formatNumber(row.skills.length))}`}</Text>
            </Text>
            <Box height={2} overflow="hidden">
              <Text wrap="wrap">{row.reason}</Text>
            </Box>
          </>
        ) : row ? (
          <>
            <Text>
              <Text bold>{row.theme.id === 'recommended' && <Text color={PALETTE.gold}>{RECOMMENDED_MARK} </Text>}{themeLabel(row.theme)}</Text>
              <Text dimColor>{`  ${m.tree.skills(formatNumber(row.skills.length))}`}</Text>
            </Text>
            <Box height={2}>
              <Text dimColor>{row.theme.id === 'recommended' ? m.tree.recommendedHint : m.tree.groupHint}</Text>
            </Box>
          </>
        ) : (
          <Box height={3}>
            <Text dimColor>{m.tree.noMatch}</Text>
          </Box>
        )}
      </Panel>

      <Hints items={hints} />
    </Box>
  );
}
