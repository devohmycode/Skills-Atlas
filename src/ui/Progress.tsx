import { Box, Text, useApp } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import type { InstallCommand } from '../install/plan.js';
import { isSuccess, phaseOf, runAll, type CommandOutcome, type Phase } from '../install/run.js';
import { ACCENT, useTerminalSize } from './Layout.js';
import { fit, width as textWidth } from './width.js';
import { TERMINAL_PALETTE as PALETTE } from './palette.js';

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_MS = 80;
const BAR_WIDTH = 24;

/** `partial`: the command ran but some of its skills were skipped or failed. */
type TaskPhase = Phase | 'partial';

interface Task {
  phase: TaskPhase;
  startedAt?: number;
  endedAt?: number;
  outcome?: CommandOutcome;
}

/**
 * Share of the bar for a running task. `skills add` gives no byte-level
 * progress, so each phase owns a band of the bar and the fill creeps
 * towards the end of that band as time passes, uv-style.
 */
export function barFraction(phase: TaskPhase, elapsedMs: number): number {
  const bands: Partial<Record<Phase, [number, number]>> = {
    fetching: [0.05, 0.55],
    installing: [0.55, 0.85],
    auditing: [0.85, 0.97],
  };
  if (phase === 'done' || phase === 'failed' || phase === 'partial') return 1;
  const band = bands[phase];
  if (!band) return 0;
  const [from, to] = band;
  return from + (to - from) * (1 - Math.exp(-elapsedMs / 4000));
}

function outcomePhase(outcome: CommandOutcome): TaskPhase {
  if (isSuccess(outcome)) return 'done';
  return outcome.results.some((r) => r.status === 'installed' || r.status === 'removed') ? 'partial' : 'failed';
}

function Bar({ fraction, color, width = BAR_WIDTH }: { fraction: number; color: string; width?: number }) {
  const exact = Math.max(0, Math.min(1, fraction)) * width;
  const full = Math.floor(exact);
  const head = full < width && exact - full > 0.3 ? '╸' : '';
  return (
    <Text>
      <Text color={color}>{'━'.repeat(full) + head}</Text>
      <Text color={PALETTE.border}>{'─'.repeat(width - full - head.length)}</Text>
    </Text>
  );
}

function seconds(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/** "uninstall · global": removals run once per scope. */
function removeLabel(c: InstallCommand): string {
  return `${t().progress.uninstallTask} · ${t().tree.where[c.scope]}`;
}

export interface ProgressProps {
  commands: InstallCommand[];
  verbose?: boolean;
  onDone: (outcomes: CommandOutcome[]) => void;
}

/**
 * Stacked progress bars, one per command (uninstall first, then one per
 * repository), an overall bar, then a uv-like `+ / - / ×` summary.
 */
export function Progress({ commands, verbose, onDone }: ProgressProps) {
  const m = t();
  const p = m.progress;
  const { exit } = useApp();
  const { columns } = useTerminalSize();
  const [tasks, setTasks] = useState<Task[]>(() => commands.map(() => ({ phase: 'queued' })));
  const [now, setNow] = useState(Date.now());
  const [finished, setFinished] = useState(false);
  const started = useRef(Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    const update = (i: number, change: (t: Task) => Task) =>
      setTasks((prev) => prev.map((task, j) => (j === i ? change(task) : task)));
    runAll(commands, {
      verbose,
      onStart: (c, i) => update(i, (task) => ({ ...task, phase: c.kind === 'remove' ? 'installing' : 'fetching', startedAt: Date.now() })),
      onOutput: (text, i) => update(i, (task) => ({ ...task, phase: task.phase === 'partial' ? task.phase : phaseOf(text, task.phase) })),
      onDone: (outcome, i) =>
        update(i, (task) => ({ ...task, outcome, endedAt: Date.now(), phase: outcomePhase(outcome) })),
    }).then((outcomes) => {
      clearInterval(timer);
      setNow(Date.now());
      setFinished(true);
      onDone(outcomes);
    });
    return () => clearInterval(timer);
  }, []);

  // Exit once the final frame (with the summary) has been rendered.
  useEffect(() => {
    if (finished) exit();
  }, [finished]);

  const installs = commands.filter((c) => c.kind === 'add');
  const removals = commands.filter((c) => c.kind === 'remove').flatMap((c) => c.skills);
  const skillCount = installs.reduce((n, c) => n + c.skills.length, 0);
  const title = [
    installs.length ? p.installing(skillCount, installs.length) : '',
    removals.length ? p.uninstalling(removals.length) : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const phaseText: Record<TaskPhase, string> = {
    queued: p.queued,
    fetching: p.fetching,
    installing: p.installing_,
    auditing: p.auditing,
    done: p.done,
    failed: p.failed,
    partial: p.partial,
  };
  const phaseW = Math.max(...Object.values(phaseText).map(textWidth));
  const labelW = Math.min(34, Math.max(12, ...commands.map((c) => textWidth(c.kind === 'remove' ? removeLabel(c) : c.source))));
  // Row: icon (2) label (2) skills (2) bar (2) phase time (7), inside a 1-column padding on each side.
  const skillsW = Math.max(8, columns - 2 - 2 - labelW - 2 - 2 - BAR_WIDTH - 2 - phaseW - 7);
  const isOver = (x: Task) => x.phase === 'done' || x.phase === 'failed' || x.phase === 'partial';
  const doneCount = tasks.filter(isOver).length;
  const spinner = SPINNER[Math.floor(now / TICK_MS) % SPINNER.length]!;
  // uv-like summary: removals, then installs, then problems.
  const rank = { removed: 0, installed: 1, skipped: 2, failed: 3 } as const;
  const results = tasks.flatMap((x) => x.outcome?.results ?? []).sort((a, b) => rank[a.status] - rank[b.status]);
  const failedWithoutResults = tasks.filter((x) => x.phase === 'failed' && !x.outcome?.results.length);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Text bold>{title}</Text>
      <Box flexDirection="column" marginY={1}>
        {commands.map((c, i) => {
          const task = tasks[i]!;
          const running = task.phase !== 'queued' && !isOver(task);
          const elapsed = task.startedAt ? (task.endedAt ?? now) - task.startedAt : 0;
          const icon =
            task.phase === 'done' ? <Text color={PALETTE.success}>✓</Text> : task.phase === 'partial' ? <Text color={PALETTE.gold}>✓</Text> : task.phase === 'failed' ? <Text color={PALETTE.danger}>✗</Text> : running ? <Text color={ACCENT}>{spinner}</Text> : <Text dimColor>·</Text>;
          const color = task.phase === 'failed' ? PALETTE.danger : task.phase === 'partial' ? PALETTE.gold : task.phase === 'done' ? PALETTE.success : ACCENT;
          const label = c.kind === 'remove' ? removeLabel(c) : c.source;
          return (
            <Text key={i} wrap="truncate-end">
              {icon}{' '}
              <Text bold={running} dimColor={task.phase === 'queued'} color={c.kind === 'remove' ? PALETTE.danger : undefined}>
                {fit(label, labelW)}
              </Text>
              {'  '}
              <Text dimColor>{fit(c.skills.join(', '), skillsW)}</Text>
              {'  '}
              <Bar fraction={barFraction(task.phase, elapsed)} color={color} />
              {'  '}
              <Text
                color={task.phase === 'failed' ? PALETTE.danger : task.phase === 'partial' ? PALETTE.gold : undefined}
                dimColor={task.phase !== 'failed' && task.phase !== 'partial'}
              >
                {fit(phaseText[task.phase], phaseW)}
              </Text>
              <Text dimColor>{task.startedAt ? seconds(elapsed).padStart(7) : ''}</Text>
            </Text>
          );
        })}
      </Box>

      {!finished ? (
        <Text>
          <Bar fraction={doneCount / commands.length} color={ACCENT} width={Math.min(48, Math.max(20, columns - 30))} />
          <Text dimColor>{`  ${doneCount}/${commands.length}  ·  ${seconds(now - started.current)}`}</Text>
        </Text>
      ) : (
        <Box flexDirection="column">
          {results.map((r, i) =>
            r.status === 'installed' ? (
              <Text key={i}>
                <Text color={PALETTE.success}> + </Text>
                <Text bold>{r.name}</Text>
                <Text dimColor>{r.agents?.length ? `  → ${r.agents.join(', ')}` : ''}</Text>
              </Text>
            ) : r.status === 'removed' ? (
              <Text key={i}>
                <Text color={PALETTE.danger}> - </Text>
                <Text bold>{r.name}</Text>
              </Text>
            ) : (
              <Text key={i}>
                <Text color={r.status === 'skipped' ? PALETTE.gold : PALETTE.danger}> × </Text>
                <Text bold>{r.name ?? '?'}</Text>
                <Text color={r.status === 'skipped' ? PALETTE.gold : PALETTE.danger}>{`  ${r.reason ?? r.error ?? m.run.failed}`}</Text>
              </Text>
            ),
          )}
          {failedWithoutResults.map((x, i) => (
            <Text key={`f${i}`} color={PALETTE.danger} wrap="truncate-end">
              {` × ${x.outcome?.command.source || p.uninstallTask}  ${x.outcome?.stderr.trim().split('\n').pop() ?? ''}`}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
