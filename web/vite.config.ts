import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const api = "http://127.0.0.1:8790";

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1600 },
  server: { port: 5178, proxy: { "/api": api, "/pay": api, "/sandbox-sim": api } },
});
