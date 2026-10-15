import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListSelect } from '../src/ui/ListSelect.js';

afterEach(cleanup);
const tick = () => new Promise((resolve) => setTimeout(resolve, 40));
const down = '\u001B[B';
const items = ['alpha', 'beta', 'gamma'].map((value) => ({ value, label: value }));

describe('ListSelect rapid input', () => {
  it('submits the cursor reached by an arrow burst before redraw', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<ListSelect title="Pick" items={items} onSubmit={onSubmit} onCancel={() => {}} />);
    await tick();
    for (const key of [down, down, '\r']) stdin.write(key);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(['gamma']);
  });

  it('filters, selects and submits a multi-select burst before redraw', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(<ListSelect title="Pick" items={items} multiple onSubmit={onSubmit} onCancel={() => {}} />);
    await tick();
    for (const key of ['g', 'a', ' ', '\r']) stdin.write(key);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith(['gamma']);
  });
});
