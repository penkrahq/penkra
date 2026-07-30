import { describe, expect, it } from "vitest";

import {
  canaryCloneArgs,
  canaryStartArgs,
  createCanaryEnvironment,
  parseCanaryArgs,
  resolveCanaryPaths,
  resolveCanaryRef,
} from "./canary";

describe("canary tooling", () => {
  it("keeps managed source and Canary data separate from Stable", () => {
    expect(resolveCanaryPaths({}, "/Users/tester")).toEqual({
      home: "/Users/tester/.synara-canary",
      source: "/Users/tester/.cache/synara-canary/source",
      state: "/Users/tester/.synara-canary/canary-state.json",
      pid: "/Users/tester/.synara-canary/canary.pid",
      log: "/Users/tester/.synara-canary/canary.log",
    });
  });

  it("supports explicit path overrides", () => {
    expect(
      resolveCanaryPaths(
        {
          SYNARA_CANARY_HOME: "/tmp/canary-data",
          SYNARA_CANARY_SOURCE: "/tmp/canary-source",
        },
        "/Users/tester",
      ),
    ).toEqual({
      home: "/tmp/canary-data",
      source: "/tmp/canary-source",
      state: "/tmp/canary-data/canary-state.json",
      pid: "/tmp/canary-data/canary.pid",
      log: "/tmp/canary-data/canary.log",
    });
  });

  it("tracks main by default and accepts a stacked PR ref", () => {
    expect(parseCanaryArgs(["update"])).toEqual({
      command: "update",
      ref: null,
    });
    expect(parseCanaryArgs(["setup", "--ref", "codex/synara-canary"])).toEqual({
      command: "setup",
      ref: "codex/synara-canary",
    });
  });

  it("checks out the managed source during clone so the cleanliness guard starts clean", () => {
    expect(canaryCloneArgs("git@example.com:synara.git", "/tmp/canary-source")).toEqual([
      "clone",
      "--",
      "git@example.com:synara.git",
      "/tmp/canary-source",
    ]);
  });

  it("starts the desktop launcher directly so the persisted PID stays alive", () => {
    expect(canaryStartArgs()).toEqual(["apps/desktop/scripts/start-electron.mjs"]);
    expect(canaryStartArgs("/tmp/canary-data")).toEqual([
      "apps/desktop/scripts/start-electron.mjs",
      "--penkra-canary-root=/tmp/canary-data",
    ]);
  });

  it("isolates the Penkra root and skips redundant login-shell probing", () => {
    const paths = resolveCanaryPaths(
      {
        SYNARA_CANARY_HOME: "/tmp/canary-data",
        SYNARA_CANARY_SOURCE: "/tmp/canary-source",
      },
      "/Users/tester",
    );
    const environment = createCanaryEnvironment(
      {
        PATH: "/usr/bin",
        VITE_DEV_SERVER_URL: "http://localhost:5173",
        ELECTRON_RENDERER_PORT: "5173",
        SYNARA_AUTH_TOKEN: "secret",
      },
      paths,
      "a".repeat(40),
    );

    expect(environment).toMatchObject({
      PATH: "/usr/bin",
      PENKRA_ROOT: "/tmp/canary-data",
      PENKRA_SKIP_LOGIN_SHELL_ENVIRONMENT: "1",
      SYNARA_DESKTOP_FLAVOR: "canary",
      SYNARA_DISABLE_AUTO_UPDATE: "1",
      SYNARA_CANARY_HOME: "/tmp/canary-data",
      SYNARA_HOME: "/tmp/canary-data",
      SYNARA_COMMIT_HASH: "a".repeat(40),
    });
    expect(environment.VITE_DEV_SERVER_URL).toBeUndefined();
    expect(environment.ELECTRON_RENDERER_PORT).toBeUndefined();
    expect(environment.SYNARA_AUTH_TOKEN).toBeUndefined();
  });

  it("keeps updating the selected stacked ref until explicitly moved to main", () => {
    expect(resolveCanaryRef(parseCanaryArgs(["setup"]), null)).toBe("main");
    expect(resolveCanaryRef(parseCanaryArgs(["update"]), "codex/synara-canary")).toBe(
      "codex/synara-canary",
    );
    expect(resolveCanaryRef(parseCanaryArgs(["update", "--ref", "main"]), "old-ref")).toBe("main");
  });

  it("rejects unsupported commands and incomplete refs", () => {
    expect(() => parseCanaryArgs(["reset"])).toThrow(/Unknown Canary command/u);
    expect(() => parseCanaryArgs(["update", "--ref"])).toThrow(/Missing value/u);
  });
});
