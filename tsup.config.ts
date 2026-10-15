import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/index': 'src/cli/index.ts',
    'cli/wbh': 'src/cli/wbh.ts',
  },
  format: ['esm'],
  outExtension: ({ format }) => ({ js: format === 'esm' ? '.mjs' : '.js' }),
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  external: ['playwright', 'playwright-core', 'playwright-core/*'],
  banner: {
    js: '#!/usr/bin/env node',
  },
});