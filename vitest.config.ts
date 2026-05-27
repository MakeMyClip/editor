import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Each file in its own process so workspace-env-var manipulations in
    // session / safety-tool tests don't leak across files. Worker threads
    // share process.env, which broke the session log isolation. Forks add a
    // few ms of per-file startup but keep state cleanly partitioned.
    pool: 'forks',
  },
});
