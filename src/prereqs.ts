import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * What a SKILL.md says it needs, from its frontmatter: the spec's `compatibility`
 * text, and the programs listed under `requires.bins` (the OpenClaw metadata,
 * in JSON or YAML form).
 */
export interface Prerequisites {
  compatibility?: { text: string; line: number };
  bins: { names: string[]; line: number } | undefined;
}

const BIN = /^[\w.+-]{1,64}$/;

export function prerequisites(markdown: string): Prerequisites {
  const lines = markdown.split('\n');
  if (lines[0]?.trim() !== '---') return { bins: undefined };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  const front = lines.slice(0, end < 0 ? lines.length : end);
  let compatibility: Prerequisites['compatibility'];
  let bins: Prerequisites['bins'];
  front.forEach((text, i) => {
    const c = /^compatibility:\s*(.+)$/.exec(text);
    if (c && !compatibility) compatibility = { text: c[1]!.trim().replace(/^(["'])(.*)\1$/, '$2').slice(0, 300), line: i + 1 };
    if (bins) return;
    // "bins": ["gh", "jq"] (JSON) or bins: [gh, jq] (YAML flow), else a YAML list below.
    const flow = /["']?\bbins["']?\s*:\s*\[([^\]]*)\]/.exec(text);
    let names = flow ? flow[1]!.split(',') : [];
    if (!flow && /^\s*["']?bins["']?\s*:\s*$/.test(text)) {
      for (let j = i + 1; j < front.length && /^\s*-\s*\S/.test(front[j]!); j++) names.push(front[j]!.replace(/^\s*-\s*/, ''));
    }
    names = names.map((n) => n.trim().replace(/^["']|["']$/g, '')).filter((n) => BIN.test(n));
    if (names.length) bins = { names: [...new Set(names)], line: i + 1 };
  });
  return { compatibility, bins };
}

const found = new Map<string, boolean>();

/** Whether a program is on this machine's PATH (with PATHEXT on Windows). */
export function onPath(name: string): boolean {
  const known = found.get(name);
  if (known !== undefined) return known;
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')] : [''];
  const yes = (process.env.PATH ?? '').split(delimiter).some((dir) => dir && exts.some((e) => existsSync(join(dir, name + e))));
  found.set(name, yes);
  return yes;
}
