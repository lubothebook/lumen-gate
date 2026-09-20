import { defineConfig } from "vite";

// gate2/web runs beside the frozen 1.0 console (5173); it never touches it.
// base is /gate2/ in dev too, because on Vercel (and behind the 1.0 dev
// proxy) the app lives under that subpath — one origin, two gates.
export default defineConfig({
  base: "/gate2/",
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
