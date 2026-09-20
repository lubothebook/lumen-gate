import { defineConfig } from "vite";

// gate2/web runs beside the frozen 1.0 console (5173); it never touches it.
export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 5174,
    allowedHosts: true,
    fs: { allow: ["../.."] },
  },
  preview: {
    host: "0.0.0.0",
    port: 5174,
    allowedHosts: true,
  },
});
