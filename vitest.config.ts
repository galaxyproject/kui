import { defineConfig } from 'vitest/config';

// Scope test discovery to source files rather than walking generated output
// in dist/ and .astro/.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
