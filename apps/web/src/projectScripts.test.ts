import { describe, expect, it } from "vitest";

import {
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptCwd,
  projectScriptRuntimeEnv,
  projectScriptIdFromCommand,
  setupProjectScript,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it("builds and parses script run commands", () => {
    const command = commandForProjectScript("lint");
    expect(command).toBe("script.lint.run");
    expect(projectScriptIdFromCommand(command)).toBe("lint");
    expect(projectScriptIdFromCommand("terminal.toggle")).toBeNull();
  });

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary and setup scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("setup");
    expect(setupProjectScript(scripts)).toBeNull();
  });

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
    });

    expect(env).toMatchObject({
      PENKRA_PROJECT_ROOT: "/repo",
    });
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      extraEnv: {
        PENKRA_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.PENKRA_PROJECT_ROOT).toBe("/custom-root");
    expect(env.CUSTOM_FLAG).toBe("1");
    expect(env.PENKRA_WORKTREE_PATH).toBeUndefined();
  });

  it("uses the project path for script cwd resolution", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
      }),
    ).toBe("/repo");
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
      }),
    ).toBe("/repo");
  });
});
