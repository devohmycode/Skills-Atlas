import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { cli: 'src/launch.ts' },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  splitting: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
