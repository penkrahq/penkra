import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

const root = import.meta.dirname;
export default defineConfig({
  build: {
    emptyOutDir: true,
    outDir: "dist",
    rollupOptions: {
      input: { app: path.join(root, "app.html"), operations: path.join(root, "operations.html") },
    },
  },
  plugins: [
    {
      name: "penkra-package-metadata",
      closeBundle() {
        for (const file of ["penkra-app.json", "README.md", "INSTRUCTIONS.md", "icon.svg"])
          fs.copyFileSync(path.join(root, file), path.join(root, "dist", file));
        fs.cpSync(path.join(root, "skills"), path.join(root, "dist", "skills"), {
          recursive: true,
        });
      },
    },
  ],
});
