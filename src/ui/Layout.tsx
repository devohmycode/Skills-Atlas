import { Box, Text, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { logo } from './logo.js';
import { useClick } from './mouse.js';
import { TERMINAL_PALETTE as PALETTE } from './palette.js';

export const ACCENT = PALETTE.accent;

export type StepId = 'scope' | 'select' | 'agents' | 'method' | 'confirm';
export const STEPS: StepId[] = ['select', 'scope', 'agents', 'method', 'confirm'];

export function useTerminalSize(): { columns: number; rows: number } {
  const { stdout } = useStdout();
  return { columns: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 };
}

/** Full ASCII logo and tagline, for the first screens when the terminal is tall enough. */
export function Banner() {
  const { columns } = useTerminalSize();
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>{logo(columns)}</Text>
      <Text dimColor>{t().tagline}</Text>
    </Box>
  );
}

/** One-line title and the wizard steps, the current one highlighted. */
export function Header({ step }: { step: StepId }) {
  const current = STEPS.indexOf(step);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color={ACCENT}>
          SKILLS ATLAS
        </Text>
        <Text dimColor>{'  ·  '}</Text>
        {STEPS.map((s, i) => (
          <Text key={s}>
            {i > 0 && <Text dimColor>{'  ›  '}</Text>}
            {i < current ? (
              <Text color={PALETTE.success}>✓ {t().steps[s]}</Text>
            ) : i === current ? (
              <Text bold color={ACCENT}>
                ● {t().steps[s]}
              </Text>
            ) : (
              <Text dimColor>○ {t().steps[s]}</Text>
            )}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

/** Key, action, and what a click on it does: hints with a handler are buttons. */
export type Hint = [key: string, action: string, onPress?: () => void];

/** Key hints: keys in the accent color, actions dimmed; clickable ones framed like buttons. */
export function Hints({ items }: { items: Hint[] }) {
  return (
    <Box marginTop={1} flexWrap="wrap" columnGap={1}>
      {items.map(([k, action, onPress]) => (
        <HintItem key={k} keyName={k} action={action} onPress={onPress} />
      ))}
    </Box>
  );
}

function HintItem({ keyName, action, onPress }: { keyName: string; action: string; onPress?: () => void }) {
  const { ref, hovered } = useClick(onPress);
  // Hovered: the whole button in reverse video, so that it reads as the thing a click will hit.
  if (hovered)
    return (
      <Box ref={ref}>
        <Text inverse bold color={ACCENT}>
          [{keyName} {action}]
        </Text>
      </Box>
    );
  const body = (
    <>
      <Text bold color={ACCENT}>
        {keyName}
      </Text>{' '}
      <Text dimColor={!onPress}>{action}</Text>
    </>
  );
  return (
    <Box ref={ref}>
      {onPress ? (
        <Text>
          <Text color={ACCENT}>[</Text>
          {body}
          <Text color={ACCENT}>]</Text>
        </Text>
      ) : (
        <Text>{body}</Text>
      )}
    </Box>
  );
}

/** Rounded panel for details and summaries. */
export function Panel({ children, color = PALETTE.border, title }: { children: ReactNode; color?: string; title?: string }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
      {title && (
        <Text bold color={color === PALETTE.border ? undefined : color}>
          {title}
        </Text>
      )}
      {children}
    </Box>
  );
}

/** Checkbox glyphs: ticked, partly ticked (groups), empty. */
export const BOX = { on: '◉', some: '◐', off: '○' } as const;
