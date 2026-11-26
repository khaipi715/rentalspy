import { defineConfig } from 'astro/config';

// Static site: every suburb and street page is built ahead of time (fast, free hosting, good for Google).
export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || undefined,
  output: 'static',
  trailingSlash: 'ignore',
  build: { format: 'directory' },
});
