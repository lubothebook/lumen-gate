import { defineConfig } from 'vite';

// Stello console sits beside the frozen 1.0/2.0 pages. base is /stello/ in
// dev too, because on Vercel (and behind the 1.0 dev proxy) the app lives
// under that subpath — one origin, three surfaces.
export default defineConfig({
  base: '/stello/',
  server: {
    host: '0.0.0.0',
    port: 5175,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 5175,
    allowedHosts: true,
  },
});
