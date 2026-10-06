import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';

// Static output: pages are shells, data comes from /api/* at runtime.
// In dev, `astro dev` proxies Worker routes to `wrangler dev` on :8787.
const worker = 'http://localhost:8787';

export default defineConfig({
  output: 'static',
  integrations: [preact()],
  build: { format: 'file' },
  vite: {
    server: {
      proxy: {
        '/api': worker,
        '/auth': worker,
        '/img': worker,
      },
    },
  },
});
