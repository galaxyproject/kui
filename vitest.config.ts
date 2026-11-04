import { defineConfig } from 'vitest/config';

// Vitest 4 only excludes node_modules and .git by default, so scope the search
// explicitly rather than letting it walk dist/ and .astro/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
