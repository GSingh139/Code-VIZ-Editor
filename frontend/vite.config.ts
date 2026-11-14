import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // The Python worker loads Pyodide via dynamic import, so emit it as an ES module.
  worker: { format: "es" },
  server: {
    host: "127.0.0.1",
    port: 5173,
    // The worker imports ../backend/app/tracer.py (raw text) from outside this folder.
    fs: { allow: [".."] },
  },
});
