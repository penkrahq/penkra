import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  readPenkraRootPointer,
  resolvePenkraRoot,
  resolvePenkraRootPointerPath,
  resolvePenkraRuntime,
} from "./penkraRoot";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Penkra root pointer", () => {
  it("keeps development on a local root and API without a production picker", () => {
    const base = temporaryDirectory();
    expect(
      resolvePenkraRuntime({
        isDevelopment: true,
        homeDir: base,
        persistedProductionRoot: Path.join(base, "production"),
      }),
    ).toEqual({
      root: Path.join(base, "Penkra_Dev"),
      apiUrl: "http://127.0.0.1:3012",
      needsRootPicker: false,
    });
  });

  it("allows explicit development overrides without changing production defaults", () => {
    const base = temporaryDirectory();
    const configuredRoot = Path.join(base, "custom-dev");
    expect(
      resolvePenkraRuntime({
        isDevelopment: true,
        homeDir: base,
        configuredRoot,
        configuredApiUrl: "http://localhost:4100/",
      }),
    ).toEqual({
      root: configuredRoot,
      apiUrl: "http://localhost:4100",
      needsRootPicker: false,
    });
    expect(
      resolvePenkraRuntime({
        isDevelopment: false,
        homeDir: base,
        configuredRoot,
      }),
    ).toEqual({
      root: Path.join(base, "Penkra"),
      apiUrl: "https://api.penkra.com",
      needsRootPicker: true,
    });
  });

  it("reuses the persisted production root", () => {
    const base = temporaryDirectory();
    const root = Path.join(base, "production");
    expect(
      resolvePenkraRuntime({
        isDevelopment: false,
        homeDir: base,
        persistedProductionRoot: root,
      }),
    ).toEqual({
      root,
      apiUrl: "https://api.penkra.com",
      needsRootPicker: false,
    });
  });

  it("persists the selected root and reuses it without another picker", () => {
    const base = temporaryDirectory();
    const selected = Path.join(base, "work");
    const first = resolvePenkraRoot({
      appDataBase: Path.join(base, "app-data"),
      homeDir: Path.join(base, "home"),
      pickDirectory: () => selected,
    });
    let pickerCalls = 0;
    const second = resolvePenkraRoot({
      appDataBase: Path.join(base, "app-data"),
      homeDir: Path.join(base, "home"),
      pickDirectory: () => {
        pickerCalls += 1;
        return null;
      },
    });

    expect(first).toMatchObject({ root: selected, created: true });
    expect(second).toMatchObject({ root: selected, created: false });
    expect(pickerCalls).toBe(0);
    expect(
      FS.statSync(resolvePenkraRootPointerPath(Path.join(base, "app-data"))).mode & 0o777,
    ).toBe(0o600);
  });

  it("treats malformed and relative pointers as missing", () => {
    const base = temporaryDirectory();
    const pointer = resolvePenkraRootPointerPath(base);
    FS.mkdirSync(Path.dirname(pointer), { recursive: true });
    FS.writeFileSync(pointer, JSON.stringify({ root: "relative/path" }));
    expect(readPenkraRootPointer(pointer)).toBeNull();
    FS.writeFileSync(pointer, "not json");
    expect(readPenkraRootPointer(pointer)).toBeNull();
  });

  it("does not write a pointer when the picker is cancelled", () => {
    const base = temporaryDirectory();
    const result = resolvePenkraRoot({
      appDataBase: Path.join(base, "app-data"),
      homeDir: Path.join(base, "home"),
      pickDirectory: () => null,
    });
    expect(result).toBeNull();
    expect(FS.existsSync(resolvePenkraRootPointerPath(Path.join(base, "app-data")))).toBe(false);
  });
});

function temporaryDirectory(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-root-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
