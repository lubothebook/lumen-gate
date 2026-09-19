import { defineConfig } from 'vite';

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
};

export default defineConfig({
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
