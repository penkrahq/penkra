import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

const POINTER_DIRECTORY_NAME = "Penkra";
const POINTER_FILE_NAME = "root.json";

export type PenkraRootResolution = {
  readonly root: string;
  readonly pointerPath: string;
  readonly created: boolean;
};

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
