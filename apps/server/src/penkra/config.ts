import path from "node:path";

export type PenkraRuntimeConfig = {
  root: string;
  endpoint: string;
  hqConfigPath: string;
};

export function resolvePenkraRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): PenkraRuntimeConfig | null {
  const root = env.PENKRA_ROOT?.trim();
  if (!root) return null;
  const endpoint = (env.PENKRA_API_URL?.trim() || "https://api.penkra.com").replace(/\/$/, "");
  return {
    root: path.resolve(root),
    endpoint,
    hqConfigPath: path.join(path.resolve(root), "hq", ".penkra", "config.json"),
  };
}
