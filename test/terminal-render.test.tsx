import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { App } from '../src/ui/App.js';
import { renderTerminal } from '../src/ui/render.js';
import type { Skill } from '../src/types.js';
import { TerminalScreen } from './helpers/terminal-screen.js';

// This test simulates an interactive terminal. CI normally tells Ink to suppress
// interactive output, so set these flags before Ink and is-in-ci are imported.
vi.hoisted(() => {
  vi.stubEnv('CI', 'false');
  vi.stubEnv('CONTINUOUS_INTEGRATION', 'false');
});
afterAll(() => vi.unstubAllEnvs());

class Output extends EventEmitter {
  isTTY = true;
  screen: TerminalScreen;
  constructor(readonly columns: number, readonly rows: number) { super(); this.screen = new TerminalScreen(columns, rows); }
  chunks: string[] = [];
  write(chunk: string) { this.chunks.push(chunk); this.screen.write(chunk); return true; }
}

class Input extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
  read() { const data = this.data; this.data = null; return data; }
  send(data: string) { this.data = data; this.emit('readable'); }
}

async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error('Terminal did not render the expected state');
}

describe('terminal rendering', () => {
  it.each([[100, 24], [180, 45]])('keeps one status line and details panel while navigating at %ix%i', async (columns, rows) => {
    const stdout = new Output(columns, rows);
    const stdin = new Input();
    const skills: Skill[] = Array.from({ length: 400 }, (_, i) => ({
      id: `owner/repo@skill-${i}`, name: `skill-${i}`, source: 'owner/repo',
      description: `Description ${i}`, installs: 400 - i, themes: ['code'], labels: [], origins: [],
    }));
    const app = renderTerminal(
      <App themes={[{ id: 'code', label: 'Code' }]} skills={skills} preset={{}}
        defaults={{ agents: ['codex'], scope: 'project', method: 'symlink' }} skillsVersion="1.7.0" onDone={() => {}} />,
      { stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stdout as unknown as NodeJS.WriteStream, patchConsole: false, exitOnCtrlC: false },
    );
    try {
      await until(() => stdin.listenerCount('readable') > 0);
      stdin.send('\u001b[C');
      await until(() => stdout.chunks.join('').includes('skill-0'));
      stdin.send('\u001b[B');
      await until(() => stdout.chunks.join('').includes('Description 0'));
      for (let i = 0; i < 8; i++) {
        stdout.chunks = [];
        stdin.send(i % 2 === 0 ? '\u001b[B' : '\u001b[A');
        await until(() => stdout.chunks.join('').includes(`Description ${i % 2 === 0 ? 1 : 0}`));
      }
      const screen = stdout.screen.text;
      expect(screen.match(/SKILLS ATLAS/g)).toHaveLength(1);
      expect(screen.match(/400 skills/g)).toHaveLength(1);
      expect(screen.match(/Code & architecture/g)).toHaveLength(1);
      expect(screen.match(/Description 0/g)).toHaveLength(1);
      expect(screen).not.toContain('Description 1');
    } finally {
      app.unmount(); app.cleanup();
    }
  });
});
