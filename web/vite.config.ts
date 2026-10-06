import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 3000,
    proxy: {
      "/health": "http://127.0.0.1:8787",
      "/v1": "http://127.0.0.1:8787",
    },
  },
});
