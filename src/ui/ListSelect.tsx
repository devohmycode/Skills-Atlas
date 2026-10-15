import { Box, Text, useInput } from 'ink';
import { useMemo, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { ACCENT, BOX, Hints, useTerminalSize, type Hint } from './Layout.js';
import { isMouseInput, useListMouse } from './mouse.js';
import { width } from './width.js';
import { TERMINAL_PALETTE as PALETTE } from './palette.js';

export interface Item<T extends string> {
  value: T;
  label: string;
  hint?: string;
  /** Short highlighted tag after the label (e.g. "detected"). */
  badge?: string;
}

export interface ListSelectProps<T extends string> {
  title: string;
  items: Item<T>[];
  multiple?: boolean;
  initial?: T[];
  onSubmit: (values: T[]) => void;
  onCancel: () => void;
}

/** Lines used around the list: header, title, filter, hints. */
const CHROME_LINES = 10;

/** Single or multiple choice list with type-to-filter, used by the wizard steps. */
export function ListSelect<T extends string>({ title, items, multiple, initial = [], onSubmit, onCancel }: ListSelectProps<T>) {
  const m = t();
  const { rows } = useTerminalSize();
  const [selected, setSelected] = useState<Set<T>>(new Set(initial));
  const [filter, setFilter] = useState('');
  const [cursor, setCursorState] = useState(() => Math.max(0, items.findIndex((i) => i.value === initial[0])));
  const live = useRef({ cursor, selected, filter });
  live.current = { cursor, selected, filter };
  const setCursor = (next: number) => {
    live.current.cursor = next;
    setCursorState(next);
  };
  const setLiveFilter = (next: string) => {
    live.current.filter = next;
    setFilter(next);
  };
  const liveShown = () => {
    const f = live.current.filter.toLowerCase();
    return f ? items.filter((i) => `${i.value} ${i.label}`.toLowerCase().includes(f)) : items;
  };
  const liveItem = () => {
    const list = liveShown();
    return list[Math.min(live.current.cursor, Math.max(0, list.length - 1))];
  };
  const move = (delta: number) => setCursor(Math.max(0, Math.min(liveShown().length - 1, live.current.cursor + delta)));

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    return f ? items.filter((i) => `${i.value} ${i.label}`.toLowerCase().includes(f)) : items;
  }, [items, filter]);
  const height = Math.max(3, Math.min(shown.length, rows - CHROME_LINES));
  const current = Math.min(cursor, Math.max(0, shown.length - 1));
  const top = Math.max(0, Math.min(current - Math.floor(height / 2), shown.length - height));
  const labelW = Math.min(28, Math.max(...items.map((i) => width(i.label) + (i.badge ? width(i.badge) + 3 : 0)))) + 2;

  const toggle = (value: T) => {
    const next = new Set(live.current.selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    live.current.selected = next;
    setSelected(next);
  };

  // Wheel moves the cursor; a click ticks an item (multiple) or chooses it (single).
  const { ref: listRef, hover } = useListMouse(Math.min(height, shown.length - top), (e) => {
    if (e.kind === 'wheelUp') move(-1);
    else if (e.kind === 'wheelDown') move(1);
    if (e.kind !== 'click' || e.line < 0 || e.line >= height) return;
    const index = top + e.line;
    const item = shown[index];
    if (!item) return;
    setCursor(index);
    if (multiple) toggle(item.value);
    else onSubmit([item.value]);
  });

  // Single choice: the focused item; multiple: the ticked ones, in list order.
  const submit = () => {
    if (multiple) {
      if (live.current.selected.size) onSubmit(items.map((i) => i.value).filter((v) => live.current.selected.has(v)));
    } else {
      const next = liveItem();
      if (next) onSubmit([next.value]);
    }
  };
  const canSubmit = multiple ? selected.size > 0 : shown.length > 0;
  const escape = () => {
    if (live.current.filter) setLiveFilter('');
    else onCancel();
  };

  useInput((input, key) => {
    if (isMouseInput(input)) return;
    if (key.upArrow) move(-1);
    else if (key.downArrow) move(1);
    else if (key.pageUp) move(-height);
    else if (key.pageDown) move(height);
    else if (key.escape) escape();
    else if (key.return) submit();
    else if (multiple && input === ' ') { const next = liveItem(); if (next) toggle(next.value); }
    else if (key.backspace || key.delete) {
      setLiveFilter(live.current.filter.slice(0, -1));
      setCursor(0);
    } else if (multiple && input && input !== ' ' && !key.ctrl && !key.meta && !key.tab) {
      setLiveFilter(live.current.filter + input);
      setCursor(0);
    }
  });

  const hints: Hint[] = multiple
    ? [
        ['↑↓', m.keys.move],
        [m.keyNames.space, m.keys.toggle],
        ['abc', m.keys.typeToFilter],
        [m.keyNames.enter, m.keys.continue, canSubmit ? submit : undefined],
        [m.keyNames.esc, filter ? m.keys.clear : m.keys.back, escape],
      ]
    : [
        ['↑↓', m.keys.move],
        [m.keyNames.enter, m.keys.choose, canSubmit ? submit : undefined],
        [m.keyNames.esc, m.keys.back, escape],
      ];

  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      {multiple && (
        <Text>
          <Text color={PALETTE.success}>
            {BOX.on} {m.agents.selected(selected.size)}
          </Text>
          {filter ? <Text color={PALETTE.gold}>{`   / ${filter}`}</Text> : null}
        </Text>
      )}
      <Box marginBottom={1} />
      <Box ref={listRef} flexDirection="column">
        {shown.slice(top, top + height).map((item, i) => {
          const focused = top + i === current;
          const hovered = i === hover && !focused;
          const on = selected.has(item.value);
          const mark = multiple ? (on ? BOX.on : BOX.off) : focused ? BOX.on : BOX.off;
          const labelText = `${item.label}${item.badge ? ` · ${item.badge}` : ''}`;
          return (
            <Text key={item.value} wrap="truncate-end">
              <Text color={ACCENT}>{focused ? '❯ ' : hovered ? '› ' : '  '}</Text>
              <Text color={(multiple ? on : focused) ? PALETTE.success : PALETTE.muted}>{mark} </Text>
              <Text bold={focused} underline={hovered} color={focused || hovered ? ACCENT : undefined}>
                {item.label}
              </Text>
              {item.badge && <Text color={PALETTE.success}>{` · ${item.badge}`}</Text>}
              <Text>{' '.repeat(Math.max(1, labelW - width(labelText)))}</Text>
              {item.hint && <Text dimColor>{item.hint}</Text>}
            </Text>
          );
        })}
      </Box>
      <Hints items={hints} />
    </Box>
  );
}
