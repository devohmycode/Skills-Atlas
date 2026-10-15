import { render, type RenderOptions } from 'ink';
import type { ReactNode } from 'react';

/** Ink 6.8's incremental writer drifts after trailing newlines; keep its stable writer. */
export function renderTerminal(node: ReactNode, options: RenderOptions = {}) {
  return render(node, { incrementalRendering: false, maxFps: 60, ...options });
}
