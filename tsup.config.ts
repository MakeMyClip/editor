import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  target: 'node24',
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: false,
});
