import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// En developpement, l'API Python tourne sur le port 8000 : on lui transmet
// tout ce qui commence par /api. En production, c'est nginx qui s'en charge.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: true } },
  },
  build: { outDir: "dist" },
});
