import { describe, expect, it } from 'vitest';
import { drift, SHARED } from '../scripts/check-shared.js';

describe('shared files check', () => {
  it('reports copies that differ or cannot be read, ignoring line endings', async () => {
    const own = async (file: string) => `${file}\n`;
    const found = await drift(async (repo, file) => {
      if (repo === 'plugins-atlas' && file === 'ui/mouse.ts') return 'changed\n';
      if (repo === 'mcp-atlas' && file === 'ui/width.ts') throw new Error('HTTP 404');
      return `${file}\r\n`;
    }, own);
    expect(found).toEqual([{ file: 'ui/mouse.ts', repo: 'plugins-atlas' }, { file: 'ui/width.ts', repo: 'mcp-atlas', error: 'HTTP 404' }]);
    expect(Object.keys(SHARED)).toContain('browser.ts');
  });
});
