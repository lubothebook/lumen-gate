import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// In production the postbuild step copies the deployment manifest and the
// anchor's stellar.toml into dist/, so the page reads them from its own origin.
// Development has no dist/: without this middleware the trust-evidence card
// would read "unavailable in this build" on a machine where the manifest is
// one directory up, which is a lie about the build rather than about the
// network. The files are served byte for byte, never transformed.
const repoEvidence = {
  name: 'serve-repo-evidence',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url || '').split('?')[0];
      const wanted = /^\/(deployments\/[\w.-]+\.json|anchor\/stellar\.toml)$/.exec(url);
      if (!wanted) return next();
      const file = path.join(here, '..', wanted[1]);
      if (!fs.existsSync(file)) return next();
      res.setHeader('Content-Type', url.endsWith('.json') ? 'application/json' : 'text/plain');
      res.setHeader('Cache-Control', 'no-store');
      fs.createReadStream(file).pipe(res);
    });
  },
};

const simulatorOrigin = process.env.VITE_SIMULATOR_ORIGIN || 'http://127.0.0.1:8080';
const facadeOrigin = process.env.VITE_FACADE_ORIGIN || 'http://127.0.0.1:8081';
const sourceProxy = {
  '/source-api': {
    target: simulatorOrigin,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/source-api/, ''),
  },
  // The anchor facade owns the relayer run and the address manifest, so the
  // page never needs the relayer's key material or a second copy of the IDs.
  '/facade': {
    target: facadeOrigin,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/facade/, ''),
  },
  // In production /api is served by serverless functions. In development the
  // same handlers run through tools/api-dev-server.js, so the console is
  // exercised against the real code path before it is deployed.
  '/api': {
    target: process.env.VITE_API_ORIGIN || 'http://127.0.0.1:3001',
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [repoEvidence],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: sourceProxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    allowedHosts: true,
    proxy: sourceProxy,
  },
});
