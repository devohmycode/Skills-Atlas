import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCatalog } from '../src/catalog/build.js';
import { fetchSkillsSh } from '../src/catalog/sources/skills-sh.js';
import { fetchSmithery } from '../src/catalog/sources/smithery.js';
import { fetchClaudePluginsDev } from '../src/catalog/sources/claude-plugins-dev.js';

vi.mock('../src/catalog/sources/skills-sh.js', () => ({ fetchSkillsSh: vi.fn() }));
vi.mock('../src/catalog/sources/smithery.js', () => ({ fetchSmithery: vi.fn() }));
vi.mock('../src/catalog/sources/claude-plugins-dev.js', () => ({ fetchClaudePluginsDev: vi.fn() }));
vi.mock('../src/catalog/sources/official.js', () => ({ fetchOfficialOwners: vi.fn(async () => undefined), markOfficial: vi.fn() }));

const one = [{ origin: 'skills.sh' as const, name: 'pdf', source: 'anthropics/skills', installs: 10 }];

beforeEach(() => {
  vi.mocked(fetchSkillsSh).mockResolvedValue(one);
  vi.mocked(fetchSmithery).mockResolvedValue([]);
  vi.mocked(fetchClaudePluginsDev).mockResolvedValue([]);
});

describe('catalog source health', () => {
  it('retains each source status when a partial collection succeeds', async () => {
    vi.mocked(fetchSmithery).mockRejectedValue(new Error('Registry unavailable'));
    const catalog = await buildCatalog();
    expect(catalog.stats.sources).toEqual({
      'skills.sh': { status: 'ok', count: 1 },
      'claude-plugins.dev': { status: 'ok', count: 0 },
      smithery: { status: 'error', count: 0, error: 'Registry unavailable' },
    });
  });

  it('bounds external diagnostic text and still refuses a completely failed collection', async () => {
    vi.mocked(fetchSmithery).mockRejectedValue(new Error('x'.repeat(1000)));
    expect((await buildCatalog()).stats.sources?.smithery.error).toHaveLength(300);
    vi.mocked(fetchSkillsSh).mockRejectedValue(new Error('down'));
    vi.mocked(fetchClaudePluginsDev).mockRejectedValue(new Error('down'));
    await expect(buildCatalog()).rejects.toThrow('every catalog source failed');
  });

  it('refuses a collection without any skill: one source empty and the others down, or all empty', async () => {
    vi.mocked(fetchSkillsSh).mockResolvedValue([]);
    vi.mocked(fetchSmithery).mockRejectedValue(new Error('down'));
    vi.mocked(fetchClaudePluginsDev).mockRejectedValue(new Error('down'));
    await expect(buildCatalog()).rejects.toThrow('the crawl found no skill');
    vi.mocked(fetchSmithery).mockResolvedValue([]);
    vi.mocked(fetchClaudePluginsDev).mockResolvedValue([]);
    await expect(buildCatalog()).rejects.toThrow('the crawl found no skill');
  });
});
