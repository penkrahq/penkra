import path from "node:path";

import { defineConfig } from "vite";

const root = import.meta.dirname;

export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: "dist",
    target: "node24",
    lib: {
      entry: path.join(root, "src/operations.js"),
      formats: ["es"],
      fileName: () => "operations.js",
    },
  },
});
