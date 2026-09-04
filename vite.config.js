import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset paths so the built site works from any directory, not just
  // a domain root — GitHub Pages serves this project under /<repo-name>/.
  base: "./",
  build: {
    outDir: "dist",
    // Three.js alone is well over the default 500 kB warning threshold, and
    // this is a single-page game with nothing to lazily load. Raise the bar
    // rather than leave a warning that can never be actioned.
    chunkSizeWarningLimit: 1600,
  },
});
