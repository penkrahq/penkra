import type { Plugin } from "vite";

const TYPESCRIPT_MODULE_PATTERN = /\.ts$/;
const EXPORTED_CUSTOM_HOOK_PATTERN =
  /\bexport\s+(?:(?:async\s+)?function\s+use[A-Z]\w*|const\s+use[A-Z]\w*)/;
const HOOK_REFERENCE_PATTERN = /\b(use[A-Z]\w*)\s*(?=[(<])/g;

/**
 * Returns the source-level hook topology for hook-only TypeScript modules.
 *
 * Vite's OXC React Refresh transform currently signatures component modules,
 * but not `.ts` modules that only export custom hooks. If one of those modules
 * adds, removes, or reorders hooks, Refresh otherwise reuses the consumer's old
 * hook state and React throws "Rendered more hooks than during the previous
 * render."
 */
export function extractExportedHookTopology(code: string): string | null {
  if (!EXPORTED_CUSTOM_HOOK_PATTERN.test(code)) return null;
  return Array.from(code.matchAll(HOOK_REFERENCE_PATTERN), (match) => match[1]).join("|");
}

/**
 * Falls back to a full development reload only when an already-loaded custom
 * hook module changes hook topology. Ordinary edits keep using Fast Refresh,
 * and production builds are unaffected.
 */
export function reactRefreshHookTopologyGuard(): Plugin {
  const topologies = new Map<string, string>();

  return {
    name: "penkra-react-refresh-hook-topology-guard",
    apply: "serve",
    enforce: "pre",
    transform(code, id) {
      const file = id.split("?", 1)[0];
      if (!file || !TYPESCRIPT_MODULE_PATTERN.test(file)) return;

      const topology = extractExportedHookTopology(code);
      if (topology === null) {
        topologies.delete(file);
      } else if (!topologies.has(file)) {
        topologies.set(file, topology);
      }
    },
    async handleHotUpdate(context) {
      if (!TYPESCRIPT_MODULE_PATTERN.test(context.file)) return;

      const previousTopology = topologies.get(context.file);
      const nextTopology = extractExportedHookTopology(await context.read());

      if (nextTopology === null) {
        topologies.delete(context.file);
      } else {
        topologies.set(context.file, nextTopology);
      }

      if (previousTopology === undefined || previousTopology === nextTopology) return;

      context.server.config.logger.info(
        `[react-refresh] Hook topology changed in ${context.file}; reloading to reset hook state.`,
      );
      context.server.ws.send({ type: "full-reload" });
      return [];
    },
  };
}
