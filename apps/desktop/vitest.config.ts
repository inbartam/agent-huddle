import { defineProject } from 'vitest/config';

// Works standalone (`npm test -w @huddle/desktop`) and as a project of the root vitest config.
export default defineProject({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'scripts/**/*.test.mjs'],
  },
});
