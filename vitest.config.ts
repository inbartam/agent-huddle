import { defineConfig } from 'vitest/config';

// One Vitest run over every workspace package. Each folder matched below is its own project
// (named after its package.json). Tests live next to the code as *.test.ts.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
