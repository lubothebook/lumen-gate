import { defineConfig } from 'vite';

const simulatorOrigin = process.env.VITE_SIMULATOR_ORIGIN || 'http://127.0.0.1:3001';
const sourceProxy = {
  '/source-api': {
    target: simulatorOrigin,
    changeOrigin: true,
    rewrite: (path) => path.replace(/^\/source-api/, ''),
  },
};

export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: sourceProxy,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: true,
    proxy: sourceProxy,
  },
});
