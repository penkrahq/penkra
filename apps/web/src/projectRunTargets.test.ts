import { describe, expect, it } from "vitest";

import {
  selectPrimaryProjectRunCommand,
  upsertProjectRunCommandScripts,
} from "./projectRunTargets";

describe("selectPrimaryProjectRunCommand", () => {
  it("prefers a saved regular project script over discovered dev", () => {
    const selected = selectPrimaryProjectRunCommand({
      project: {
        cwd: "/repo",
        scripts: [
          {
            id: "serve",
            name: "Serve",
            command: "pnpm serve",
            icon: "play",
          },
        ],
      },
      discoveredTargets: [
        {
          cwd: "/repo",
          relativePath: "",
          packageJsonPath: "/repo/package.json",
          scripts: [{ name: "dev", command: "pnpm run dev" }],
        },
      ],
    });

    expect(selected).toMatchObject({
      source: "saved",
      label: "Serve",
      command: "pnpm serve",
      cwd: "/repo",
    });
  });

  it("prefers discovered dev over start", () => {
    const selected = selectPrimaryProjectRunCommand({
      project: { cwd: "/repo", scripts: [] },
      discoveredTargets: [
        {
          cwd: "/repo",
          relativePath: "",
          packageJsonPath: "/repo/package.json",
          scripts: [
            { name: "start", command: "npm run start" },
            { name: "dev", command: "npm run dev" },
          ],
        },
      ],
    });

    expect(selected).toMatchObject({
      source: "discovered",
      label: "dev",
      command: "npm run dev",
    });
  });

  it("falls back to discovered start when dev is unavailable", () => {
    const selected = selectPrimaryProjectRunCommand({
      project: { cwd: "/repo", scripts: [] },
      discoveredTargets: [
        {
          cwd: "/repo/apps/web",
          relativePath: "apps/web",
          packageJsonPath: "/repo/apps/web/package.json",
          scripts: [{ name: "start", command: "yarn start" }],
        },
      ],
    });

    expect(selected).toMatchObject({
      source: "discovered",
      label: "apps/web start",
      command: "yarn start",
      cwd: "/repo/apps/web",
    });
  });

  it("returns null when there is no saved or discovered run command", () => {
    const selected = selectPrimaryProjectRunCommand({
      project: { cwd: "/repo", scripts: [] },
      discoveredTargets: [
        {
          cwd: "/repo",
          relativePath: "",
          packageJsonPath: "/repo/package.json",
          scripts: [{ name: "build", command: "npm run build" }],
        },
      ],
    });

    expect(selected).toBeNull();
  });
});

describe("upsertProjectRunCommandScripts", () => {
  it("ignores empty and unchanged commands", () => {
    const scripts = [
      {
        id: "dev",
        name: "Dev",
        command: "bun dev",
        icon: "play" as const,
      },
    ];

    expect(upsertProjectRunCommandScripts({ scripts, command: "   " })).toBeNull();
    expect(upsertProjectRunCommandScripts({ scripts, command: "bun dev" })).toBeNull();
  });

  it("updates the primary script without changing its siblings", () => {
    const setup = {
      id: "setup",
      name: "Setup",
      command: "bun install",
      icon: "play" as const,
    };
    const scripts = [
      setup,
      {
        id: "dev",
        name: "Dev",
        command: "bun dev",
        icon: "play" as const,
      },
    ];

    const result = upsertProjectRunCommandScripts({ scripts, command: "bun dev:new" });

    expect(result).toEqual([{ ...setup, command: "bun dev:new" }, scripts[1]]);
    expect(result?.[1]).toBe(scripts[1]);
  });

  it("updates the existing primary script", () => {
    const scripts = [
      {
        id: "dev",
        name: "Setup",
        command: "bun install",
        icon: "play" as const,
      },
    ];

    expect(upsertProjectRunCommandScripts({ scripts, command: "bun dev" })).toEqual([
      { ...scripts[0], command: "bun dev" },
    ]);
  });
});
