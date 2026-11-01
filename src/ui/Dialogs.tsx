import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { formatNumber, t } from '../i18n/index.js';
import type { Scope } from '../types.js';
import { ACCENT, Hints, Panel } from './Layout.js';
import { isMouseInput } from './mouse.js';
import { TERMINAL_PALETTE as PALETTE } from './palette.js';

/**
 * The tree's own windows, for what needs no install: naming a pack, confirming a
 * deletion, picking a backup, choosing where a profile goes. Each one takes the keys
 * while it is open; the tree under it keeps its state.
 */

/** A saved scope, as the backups window lists it. */
export interface BackupSummary {
  id: string;
  createdAt: string;
  scope: Scope;
  reason: string;
  initial: boolean;
  skills: { name: string; source?: string }[];
}

/** What activating a pack as a profile would do in a scope. */
export interface ProfilePreview {
  keep: string[];
  remove: { id: string }[];
  install: string[];
}

/** Text fields typed in turn: Tab or ↓ goes to the next one, Enter on the last one saves. */
export function FormDialog({ title, fields, onSubmit, onCancel }: {
  title: string;
  fields: { label: string; value: string }[];
  /** Returns an error to show, or nothing when it is done. */
  onSubmit: (values: string[]) => string | undefined;
  onCancel: () => void;
}) {
  const m = t();
  const [values, setValues] = useState(fields.map((f) => f.value));
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string>();
  const submit = () => {
    if (!values[0]!.trim()) return setError(m.tree.fieldRequired(fields[0]!.label));
    const err = onSubmit(values.map((v) => v.trim()));
    setError(err);
    // Most refusals are about the name (an id already taken): back to it.
    if (err) setIndex(0);
  };
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (key.escape) return onCancel();
    if (key.return) return index < fields.length - 1 ? setIndex(index + 1) : submit();
    if (key.tab || key.downArrow) return setIndex((index + 1) % fields.length);
    if (key.upArrow) return setIndex((index + fields.length - 1) % fields.length);
    setError(undefined);
    if (key.backspace || key.delete) setValues(values.map((v, i) => (i === index ? v.slice(0, -1) : v)));
    else if (input && !key.ctrl && !key.meta) setValues(values.map((v, i) => (i === index ? v + input : v)));
  });
  return (
    <Box flexDirection="column">
      <Text bold color={ACCENT}>{title}</Text>
      <Panel>
        <Box flexDirection="column">
          {fields.map((f, i) => (
            <Box key={f.label} flexDirection="column" marginBottom={i < fields.length - 1 ? 1 : 0}>
              <Text dimColor={i !== index} bold={i === index}>{f.label}</Text>
              <Text>
                <Text color={i === index ? ACCENT : PALETTE.muted}>{i === index ? '› ' : '  '}</Text>
                {values[i]}
                {i === index && <Text color={ACCENT}>▌</Text>}
              </Text>
            </Box>
          ))}
        </Box>
      </Panel>
      {error && <Text color={PALETTE.danger}>{`✗ ${error}`}</Text>}
      <Hints items={[
        ['tab', m.keys.nextField, () => setIndex((index + 1) % fields.length)],
        [m.keyNames.enter, index < fields.length - 1 ? m.keys.nextField : m.keys.save, index < fields.length - 1 ? () => setIndex(index + 1) : submit],
        [m.keyNames.esc, m.keys.cancelEdit, onCancel],
      ]} />
    </Box>
  );
}

/** A yes/no question; only y (or o, j, s) says yes. */
export function ConfirmDialog({ title, lines = [], tone = 'warn', onYes, onNo }: {
  title: string;
  lines?: string[];
  tone?: 'warn' | 'danger';
  onYes: () => void;
  onNo: () => void;
}) {
  const m = t();
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (/^[yojs]$/i.test(input)) onYes();
    else if (key.escape || /^n$/i.test(input) || key.return) onNo();
  });
  return (
    <Box flexDirection="column">
      <Text bold color={tone === 'danger' ? PALETTE.danger : PALETTE.gold}>{`⚠ ${title}`}</Text>
      {lines.length > 0 && (
        <Panel>
          <Box flexDirection="column">{lines.map((l, i) => <Text key={i} wrap="truncate-end">{l}</Text>)}</Box>
        </Panel>
      )}
      <Hints items={[['y', m.keys.yes, onYes], ['n', m.keys.no, onNo]]} />
    </Box>
  );
}

/** The backups, newest first: Enter on one asks before restoring it. */
export function BackupsDialog({ backups, height, onRestore, onClose }: {
  backups: BackupSummary[];
  height: number;
  /** Restores one; returns an error to show, or nothing when it is done. */
  onRestore: (id: string) => Promise<string | undefined>;
  onClose: () => void;
}) {
  const m = t();
  const [cursor, setCursor] = useState(0);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const shown = Math.max(3, Math.floor(height / 3));
  const top = Math.max(0, Math.min(cursor - Math.floor(shown / 2), backups.length - shown));
  const restore = () => {
    const b = backups[cursor];
    if (!b) return;
    setBusy(true);
    void onRestore(b.id).then((err) => {
      setBusy(false);
      setConfirming(false);
      setError(err);
    });
  };
  useInput((input, key) => {
    if (isMouseInput(input) || busy) return;
    if (confirming) {
      if (/^[yojs]$/i.test(input)) restore();
      else setConfirming(false);
      return;
    }
    if (key.escape || input === 'q' || input === 'B') onClose();
    else if (key.upArrow || input === 'k') setCursor(Math.max(0, cursor - 1));
    else if (key.downArrow || input === 'j') setCursor(Math.min(backups.length - 1, cursor + 1));
    else if (key.return && backups.length) setConfirming(true);
  });
  const current = backups[cursor];
  return (
    <Box flexDirection="column">
      <Text bold color={ACCENT}>{m.web.backupsTitle}</Text>
      <Text dimColor wrap="wrap">{m.web.backupsHint}</Text>
      <Panel>
        <Box flexDirection="column">
          {!backups.length && <Text dimColor>{m.cli.profileNoBackup}</Text>}
          {backups.slice(top, top + shown).map((b, i) => {
            const on = top + i === cursor;
            return (
              <Box key={b.id} flexDirection="column" marginBottom={1}>
                <Text color={on ? ACCENT : undefined} bold={on}>
                  {on ? '› ' : '  '}
                  {`${b.createdAt.slice(0, 16).replace('T', ' ')}  ·  ${m.tree.where[b.scope]}  ·  ${m.web.backupSkills.replace('{n}', formatNumber(b.skills.length))}`}
                  {b.initial && <Text color={PALETTE.pink}>{`  ·  ${m.web.backupInitial}`}</Text>}
                </Text>
                <Text dimColor wrap="truncate-end">{`    ${b.reason} — ${b.skills.map((s) => s.name).join(', ') || '∅'}`}</Text>
              </Box>
            );
          })}
        </Box>
      </Panel>
      {error && <Text color={PALETTE.danger}>{`✗ ${error}`}</Text>}
      {busy ? (
        <Text color={PALETTE.gold}>{m.tree.restoring}</Text>
      ) : confirming && current ? (
        <>
          <Text bold color={PALETTE.gold}>{`⚠ ${m.web.backupRestoreConfirm}`}</Text>
          <Hints items={[['y', m.keys.restore, restore], ['n', m.keys.no, () => setConfirming(false)]]} />
        </>
      ) : (
        <Hints items={[['↑↓', m.keys.move], ...(backups.length ? [[m.keyNames.enter, m.keys.restore, () => setConfirming(true)] as [string, string, () => void]] : []), [m.keyNames.esc, m.keys.back, onClose]]} />
      )}
    </Box>
  );
}

/** A pack as a profile: the scope (← →), what stays, goes and comes; Enter goes on to the install. */
export function ProfileDialog({ label, plan, height, initialScope = 'global', onConfirm, onCancel }: {
  label: string;
  plan: (scope: Scope) => Promise<ProfilePreview>;
  height: number;
  initialScope?: Scope;
  onConfirm: (scope: Scope) => void;
  onCancel: () => void;
}) {
  const m = t();
  const [scope, setScope] = useState<Scope>(initialScope);
  const [preview, setPreview] = useState<ProfilePreview>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setPreview(undefined);
    setError(undefined);
    plan(scope).then((p) => live && setPreview(p), (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [scope]);
  const changes = preview ? preview.remove.length + preview.install.length : 0;
  const toggle = () => setScope(scope === 'global' ? 'project' : 'global');
  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (key.escape) onCancel();
    else if (key.leftArrow || key.rightArrow || key.tab || input === 'g' || input === 'p') {
      if (input === 'g') setScope('global');
      else if (input === 'p') setScope('project');
      else toggle();
    } else if (key.return && changes) onConfirm(scope);
  });
  const room = Math.max(4, height - 8);
  const lines = preview ? [...preview.remove.map((r) => ({ sign: '−', id: r.id })), ...preview.install.map((id) => ({ sign: '+', id }))] : [];
  return (
    <Box flexDirection="column">
      <Text bold color={ACCENT}>{m.cli.profileTitle(label, m.tree.where[scope])}</Text>
      <Text>
        <Text dimColor>{`${m.confirm.scope}: `}</Text>
        {(['global', 'project'] as Scope[]).map((sc) => (
          <Text key={sc} color={sc === scope ? ACCENT : PALETTE.muted} bold={sc === scope}>{`${sc === scope ? '◉' : '○'} ${m.tree.where[sc]}   `}</Text>
        ))}
      </Text>
      <Panel>
        <Box flexDirection="column">
          {error ? <Text color={PALETTE.danger}>{error}</Text> : !preview ? <Text color={PALETTE.gold}>{m.tree.previewLoading}</Text> : (
            <>
              <Text dimColor>{m.cli.profileKeep(String(preview.keep.length))}</Text>
              {lines.slice(0, room).map((l) => (
                <Text key={l.sign + l.id} color={l.sign === '+' ? PALETTE.success : PALETTE.danger} wrap="truncate-end">{`${l.sign} ${l.id}`}</Text>
              ))}
              {lines.length > room && <Text dimColor>{m.tree.andMore(formatNumber(lines.length - room))}</Text>}
              {!changes && <Text dimColor>{m.run.noChange}</Text>}
            </>
          )}
        </Box>
      </Panel>
      {preview && preview.remove.length > 0 && <Text color={PALETTE.gold} wrap="wrap">{`⚠ ${m.cli.profileWarning(String(preview.remove.length))}`}</Text>}
      <Hints items={[
        ['← →', m.keys.scope, toggle],
        [m.keyNames.enter, m.keys.profileApply, changes ? () => onConfirm(scope) : undefined],
        [m.keyNames.esc, m.keys.cancelEdit, onCancel],
      ]} />
    </Box>
  );
}
