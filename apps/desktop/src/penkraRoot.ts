import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import type { SynaraDesktopFlavor } from "@synara/shared/desktopIdentity";

const POINTER_DIRECTORY_NAME = "Penkra";
const POINTER_FILE_NAME = "root.json";
// Development keeps its files separate even when it uses the live account services.
const DEVELOPMENT_ROOT_DIRECTORY_NAME = "Penkra_Dev";
const PRODUCTION_API_URL = "https://api.penkra.com";

export type PenkraRootResolution = {
  readonly root: string;
  readonly pointerPath: string;
  readonly created: boolean;
};

export type PenkraRuntimeResolution = {
  readonly root: string;
  readonly apiUrl: string;
  readonly needsRootPicker: boolean;
};

const CANARY_ROOT_ARGUMENT_PREFIX = "--penkra-canary-root=";

export function readCanaryRootArgument(argv: ReadonlyArray<string>): string | undefined {
  for (const argument of argv) {
    if (!argument.startsWith(CANARY_ROOT_ARGUMENT_PREFIX)) continue;
    const root = argument.slice(CANARY_ROOT_ARGUMENT_PREFIX.length).trim();
    if (root && Path.isAbsolute(root)) {
      return Path.resolve(root);
    }
  }
  return undefined;
}

export function resolveConfiguredPenkraRoot(input: {
  readonly desktopFlavor: SynaraDesktopFlavor;
  readonly canaryRootArgument?: string | undefined;
  readonly canaryHome?: string | undefined;
  readonly penkraRoot?: string | undefined;
  readonly synaraHome?: string | undefined;
}): string | undefined {
  if (input.desktopFlavor === "canary") {
    return (
      input.canaryRootArgument?.trim() ||
      input.canaryHome?.trim() ||
      input.synaraHome?.trim() ||
      input.penkraRoot?.trim() ||
      undefined
    );
  }
  return input.penkraRoot?.trim() || undefined;
}

export function resolvePenkraRuntime(input: {
  readonly isDevelopment: boolean;
  readonly allowConfiguredRoot?: boolean;
  readonly homeDir?: string;
  readonly configuredRoot?: string | undefined;
  readonly configuredApiUrl?: string | undefined;
  readonly persistedProductionRoot?: string | null;
}): PenkraRuntimeResolution {
  const homeDir = input.homeDir ?? OS.homedir();
  const configuredRoot = input.configuredRoot?.trim();
  const configuredApiUrl = input.configuredApiUrl?.trim();

  if (input.isDevelopment) {
    return {
      root: Path.resolve(configuredRoot || Path.join(homeDir, DEVELOPMENT_ROOT_DIRECTORY_NAME)),
      apiUrl: (configuredApiUrl || PRODUCTION_API_URL).replace(/\/$/, ""),
      needsRootPicker: false,
    };
  }

  if (input.allowConfiguredRoot && configuredRoot) {
    return {
      root: Path.resolve(configuredRoot),
      apiUrl: (configuredApiUrl || PRODUCTION_API_URL).replace(/\/$/, ""),
      needsRootPicker: false,
    };
  }

  const persistedRoot = input.persistedProductionRoot ?? null;
  return {
    root: persistedRoot ? Path.resolve(persistedRoot) : Path.join(homeDir, POINTER_DIRECTORY_NAME),
    apiUrl: (configuredApiUrl || PRODUCTION_API_URL).replace(/\/$/, ""),
    needsRootPicker: persistedRoot === null,
  };
}

export function resolvePenkraRoot(input: {
  readonly appDataBase: string;
  readonly homeDir?: string;
  readonly pickDirectory: (defaultPath: string) => string | null;
}): PenkraRootResolution | null {
  const pointerPath = resolvePenkraRootPointerPath(input.appDataBase);
  const existing = readPenkraRootPointer(pointerPath);
  if (existing) {
    FS.mkdirSync(existing, { recursive: true, mode: 0o700 });
    return { root: existing, pointerPath, created: false };
  }

  const defaultRoot = Path.join(input.homeDir ?? OS.homedir(), POINTER_DIRECTORY_NAME);
  FS.mkdirSync(defaultRoot, { recursive: true, mode: 0o700 });
  const selected = input.pickDirectory(defaultRoot);
  if (!selected) return null;
  const root = Path.resolve(selected);
  FS.mkdirSync(root, { recursive: true, mode: 0o700 });
  writePenkraRootPointer(pointerPath, root);
  return { root, pointerPath, created: true };
}

export function resolvePenkraRootPointerPath(appDataBase: string): string {
  return Path.join(appDataBase, POINTER_DIRECTORY_NAME, POINTER_FILE_NAME);
}

export function readPenkraRootPointer(pointerPath: string): string | null {
  try {
    const parsed = JSON.parse(FS.readFileSync(pointerPath, "utf8")) as { root?: unknown };
    if (typeof parsed.root !== "string" || !Path.isAbsolute(parsed.root)) return null;
    return Path.resolve(parsed.root);
  } catch {
    return null;
  }
}

export function writePenkraRootPointer(pointerPath: string, root: string): void {
  const directory = Path.dirname(pointerPath);
  FS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = Path.join(directory, `.${POINTER_FILE_NAME}.${process.pid}.tmp`);
  const contents = `${JSON.stringify({ root }, null, 2)}\n`;
  try {
    FS.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const descriptor = FS.openSync(temporaryPath, "r");
    try {
      FS.fsyncSync(descriptor);
    } finally {
      FS.closeSync(descriptor);
    }
    FS.renameSync(temporaryPath, pointerPath);
    const directoryDescriptor = FS.openSync(directory, "r");
    try {
      FS.fsyncSync(directoryDescriptor);
    } finally {
      FS.closeSync(directoryDescriptor);
    }
  } finally {
    FS.rmSync(temporaryPath, { force: true });
  }
}
