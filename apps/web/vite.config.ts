// FILE: vite.config.ts
// Purpose: Builds the Penkra web client and controls diagnostic source maps.
// Layer: Web build config
// Depends on: Vite, Tailwind, React compiler, TanStack Router.

import fs from "node:fs/promises";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel, { defineRolldownBabelPreset } from "@rolldown/plugin-babel";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig, type Plugin } from "vite";
import pkg from "./package.json" with { type: "json" };
import { reactRefreshHookTopologyGuard } from "./viteReactRefreshGuard.js";

interface ReactCompilerEvent {
  readonly kind: string;
  readonly fnName?: string | null | undefined;
  readonly detail?: { readonly reason?: string; readonly description?: string } | undefined;
}

const REACT_COMPILER_CONTRACTS = [
  { relativePath: "src/components/ChatView.tsx", allowedBailoutReasons: [] },
  {
    relativePath: "src/components/chat/MessagesTimeline.tsx",
    // useStableRows intentionally reuses row identities through a render-time ref.
    allowedBailoutReasons: ["Cannot access refs during render"],
  },
  { relativePath: "src/components/chat/ChatTranscriptPane.tsx", allowedBailoutReasons: [] },
  { relativePath: "src/components/ChatMarkdown.tsx", allowedBailoutReasons: [] },
] as const;

function reactCompilerContract() {
  const eventsByRelativePath = new Map<string, ReactCompilerEvent[]>();
  const compilerPreset = reactCompilerPreset();

  return {
    preset: defineRolldownBabelPreset({
      ...compilerPreset,
      preset: () => ({
        plugins: [
          [
            "babel-plugin-react-compiler",
            {
              panicThreshold: "none",
              logger: {
                logEvent: (filename: string | null, event: ReactCompilerEvent) => {
                  const normalizedFilename = filename?.replaceAll("\\", "/");
                  if (!normalizedFilename) return;
                  const contract = REACT_COMPILER_CONTRACTS.find(({ relativePath }) =>
                    normalizedFilename.endsWith(`/${relativePath}`),
                  );
                  if (!contract) return;
                  const events = eventsByRelativePath.get(contract.relativePath) ?? [];
                  events.push(event);
                  eventsByRelativePath.set(contract.relativePath, events);
                },
              },
            },
          ],
        ],
      }),
    }),
    verifier: {
      name: "penkra:react-compiler-contract",
      apply: "build" as const,
      closeBundle() {
        const failures: string[] = [];
        for (const contract of REACT_COMPILER_CONTRACTS) {
          const events = eventsByRelativePath.get(contract.relativePath) ?? [];
          const bailoutReasons = events
            .filter((event) => event.kind === "CompileError")
            .map((event) => event.detail?.reason ?? event.detail?.description ?? "unknown")
            .toSorted();
          const allowedBailoutReasons = [...contract.allowedBailoutReasons].toSorted();
          if (JSON.stringify(bailoutReasons) !== JSON.stringify(allowedBailoutReasons)) {
            failures.push(
              `${contract.relativePath}: expected bailouts ${JSON.stringify(allowedBailoutReasons)}, received ${JSON.stringify(bailoutReasons)}`,
            );
          }
          if (!events.some((event) => event.kind === "CompileSuccess")) {
            failures.push(
              `${contract.relativePath}: React Compiler reported no successful function.`,
            );
          }
        }
        if (failures.length > 0) {
          throw new Error(`React Compiler contract failed:\n${failures.join("\n")}`);
        }
        console.info(
          `[react-compiler-contract] verified ${REACT_COMPILER_CONTRACTS.length} production hot-path modules.`,
        );
      },
    } satisfies Plugin,
  };
}

const reactCompiler = reactCompilerContract();

const port = Number(process.env.PORT ?? 5733);
const sourcemapEnv = process.env.PENKRA_WEB_SOURCEMAP?.trim().toLowerCase();

const buildSourcemap =
  sourcemapEnv === "1" || sourcemapEnv === "true"
    ? true
    : sourcemapEnv === "hidden"
      ? "hidden"
      : false;

const CENTRAL_ICON_DIR = "central-icons-reversed";
const CENTRAL_ICON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

async function listFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const result: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      result.push(entryPath);
    }
  }
  return result;
}

// Finds literal icon basenames in source, then prunes the copied public icon set after build.
function centralIconPrunePlugin(): Plugin {
  let resolvedRoot = process.cwd();
  let resolvedOutDir = "dist";
  return {
    name: "penkra-central-icon-prune",
    apply: "build",
    configResolved(config) {
      resolvedRoot = config.root;
      resolvedOutDir = path.resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const publicIconDir = path.join(resolvedRoot, "public", CENTRAL_ICON_DIR);
      const distIconDir = path.join(resolvedOutDir, CENTRAL_ICON_DIR);
      const iconFiles = await fs.readdir(publicIconDir).catch(() => []);
      const availableIcons = new Set(
        iconFiles
          .filter((name) => name.endsWith(".svg"))
          .map((name) => name.slice(0, -".svg".length)),
      );
      if (availableIcons.size === 0) return;

      const sourceFiles = (await listFiles(path.join(resolvedRoot, "src"))).filter((file) =>
        SOURCE_EXTENSIONS.has(path.extname(file)),
      );
      const requiredIcons = new Set<string>();
      const literalPattern = /["'`]([a-z0-9][a-z0-9-]*)["'`]/g;
      for (const sourceFile of sourceFiles) {
        const source = await fs.readFile(sourceFile, "utf8").catch(() => "");
        for (const match of source.matchAll(literalPattern)) {
          const iconName = match[1];
          if (
            iconName &&
            CENTRAL_ICON_NAME_PATTERN.test(iconName) &&
            availableIcons.has(iconName)
          ) {
            requiredIcons.add(iconName);
          }
        }
      }

      if (requiredIcons.size === 0) return;
      const copiedIconFiles = await fs.readdir(distIconDir).catch(() => []);
      let removedCount = 0;
      await Promise.all(
        copiedIconFiles.map(async (fileName) => {
          if (!fileName.endsWith(".svg")) return;
          const iconName = fileName.slice(0, -".svg".length);
          if (requiredIcons.has(iconName)) return;
          removedCount += 1;
          await fs.rm(path.join(distIconDir, fileName), { force: true });
        }),
      );
      console.info(
        `[central-icons] kept ${requiredIcons.size}/${availableIcons.size} referenced SVGs, pruned ${removedCount}.`,
      );
    },
  };
}

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    reactRefreshHookTopologyGuard(),
    react(),
    babel({
      // We need to be explicit about the parser options after moving to @vitejs/plugin-react v6.0.0
      // This is because the babel plugin only automatically parses typescript and jsx based on relative paths (e.g. "**/*.ts")
      // whereas the previous version of the plugin parsed all files with a .ts extension.
      // This is causing our packages/ directory to fail to parse, as they are not relative to the CWD.
      parserOpts: { plugins: ["typescript", "jsx"] },
      presets: [reactCompiler.preset],
    }),
    reactCompiler.verifier,
    tailwindcss(),
    centralIconPrunePlugin(),
  ],
  optimizeDeps: {
    include: [
      "@pierre/diffs",
      "@pierre/diffs/react",
      "@pierre/diffs/worker/worker.js",
      "@dnd-kit/dom/sortable",
      "react-icons/gr",
    ],
  },
  define: {
    // In dev mode, tell the web app where the WebSocket server lives
    "import.meta.env.VITE_WS_URL": JSON.stringify(process.env.VITE_WS_URL ?? ""),
    "import.meta.env.APP_VERSION": JSON.stringify(pkg.version),
  },
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port,
    strictPort: true,
    // The thread route is Penkra's primary desktop surface, but router-level
    // code splitting otherwise leaves its large React transform cold until the
    // index route restores a Thread. Warm the complete route graph while
    // Electron is starting so the visible app never sits on SplashScreen while
    // Vite compiles ChatView on first navigation.
    warmup: {
      clientFiles: [
        "./src/routes/_chat.$threadId.tsx",
        "./src/components/chat/SingleChatSurface.tsx",
        "./src/components/chat/SplitChatSurface.tsx",
        "./src/components/ChatView.tsx",
      ],
    },
    hmr: {
      // Explicit config so Vite's HMR WebSocket connects reliably
      // inside Electron's BrowserWindow. Vite 8 uses console.debug for
      // connection logs — enable "Verbose" in DevTools to see them.
      protocol: "ws",
      host: "localhost",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: buildSourcemap,
    // The largest chunks are intentionally lazy-loaded editor grammars,
    // terminal runtime code, and the chat route—not initial-load bundles.
    chunkSizeWarningLimit: 850,
    rolldownOptions: {
      checks: {
        // React Compiler is expected to dominate transform time in this app.
        pluginTimings: false,
      },
    },
  },
});
