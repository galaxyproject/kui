// @ts-check
import { defineConfig } from 'astro/config';
import vue from '@astrojs/vue';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://galaxyproject.github.io',
  base: '/kui',
  integrations: [vue()],
  vite: {
    plugins: [tailwindcss()],
  },
});
