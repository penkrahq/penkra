// FILE: localModelRuntime.ts
// Purpose: Installs the hidden MLX runtime for the Local provider on first use:
// a pinned, checksum-verified uv binary, a uv-managed Python, and a pinned mlx-lm.
// Users never see or manage Python.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const LOCAL_RUNTIME_VERSION = "mlx-lm-0.32.2+uv-0.13.9+py3.12";
const MLX_LM_VERSION = "0.32.2";
const PYTHON_VERSION = "3.12";
const UV = {
  url: "https://github.com/astral-sh/uv/releases/download/0.13.9/uv-aarch64-apple-darwin.tar.gz",
  sha256: "5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca",
  binaryInArchive: "uv-aarch64-apple-darwin/uv",
};

export interface LocalRuntimePaths {
  readonly root: string;
  readonly pythonPath: string;
}

export function localRuntimePaths(stateDir: string): LocalRuntimePaths {
  const root = path.join(stateDir, "local-models", "runtime", LOCAL_RUNTIME_VERSION);
  return { root, pythonPath: path.join(root, "venv", "bin", "python") };
}

export function localRuntimeSupported(platform = process.platform, arch = process.arch): boolean {
  return platform === "darwin" && arch === "arm64";
}

export async function isLocalRuntimeInstalled(stateDir: string): Promise<boolean> {
  const { root } = localRuntimePaths(stateDir);
  try {
    return (await readFile(path.join(root, "installed"), "utf8")).trim() === LOCAL_RUNTIME_VERSION;
  } catch {
    return false;
  }
}

/** Idempotent. Rebuilds from scratch if a previous install was interrupted. */
export async function installLocalRuntime(input: {
  readonly stateDir: string;
  readonly onStep?: (step: "download-runtime" | "install-python" | "install-mlx") => void;
  readonly fetchImpl?: typeof fetch;
}): Promise<LocalRuntimePaths> {
  if (!localRuntimeSupported()) throw new Error("Local models need a Mac with Apple silicon.");
  const paths = localRuntimePaths(input.stateDir);
  if (await isLocalRuntimeInstalled(input.stateDir)) return paths;
  await rm(paths.root, { recursive: true, force: true });
  await mkdir(paths.root, { recursive: true });

  input.onStep?.("download-runtime");
  const response = await (input.fetchImpl ?? fetch)(UV.url);
  if (!response.ok) throw new Error(`Could not download the local model runtime (${response.status}).`);
  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== UV.sha256) throw new Error("The local model runtime download failed verification.");
  const archivePath = path.join(paths.root, "uv.tar.gz");
  await writeFile(archivePath, archive);
  await run("/usr/bin/tar", ["-xzf", archivePath, "-C", paths.root]);
  await rm(archivePath);
  const uv = path.join(paths.root, UV.binaryInArchive);

  const env = {
    PATH: "/usr/bin:/bin",
    HOME: paths.root,
    UV_PYTHON_INSTALL_DIR: path.join(paths.root, "python"),
    UV_CACHE_DIR: path.join(paths.root, "uv-cache"),
    UV_NO_CONFIG: "1",
  };
  input.onStep?.("install-python");
  await run(uv, ["venv", "--python", PYTHON_VERSION, "--managed-python", path.join(paths.root, "venv")], { env });
  input.onStep?.("install-mlx");
  await run(uv, ["pip", "install", "--python", paths.pythonPath, `mlx-lm==${MLX_LM_VERSION}`], {
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  await rm(env.UV_CACHE_DIR, { recursive: true, force: true });
  await writeFile(path.join(paths.root, "installed"), LOCAL_RUNTIME_VERSION);
  return paths;
}
