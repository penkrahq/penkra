import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { discoverEnabledAppSkills } from "./appSkillsCatalog";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

describe("App skills catalog", () => {
  it("loads only enabled skills with desktop-attributed App scope", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-app-skill-"));
    roots.push(root);
    const skillPath = Path.join(root, "SKILL.md");
    FS.writeFileSync(
      skillPath,
      "---\nname: linear-create-issue\ndescription: Create an issue.\n---\n",
    );
    const request = vi.fn(async () => [
      {
        appId: "com.acme.linear",
        slug: "linear",
        name: "Linear",
        path: "skills/create-issue",
        skillPath,
        enabled: true,
        scope: "app:linear",
      },
      {
        appId: "com.acme.linear",
        slug: "linear",
        name: "Linear",
        path: "skills/archive-issue",
        skillPath,
        enabled: false,
        scope: "app:linear",
      },
    ]);

    await expect(discoverEnabledAppSkills("personal", request)).resolves.toEqual([
      expect.objectContaining({ name: "linear-create-issue", scope: "app:linear", enabled: true }),
    ]);
    expect(request).toHaveBeenCalledWith("skills.list", { spaceId: "personal" });
  });

  it("rejects mismatched attribution from the desktop boundary", async () => {
    await expect(
      discoverEnabledAppSkills("personal", async () => [
        {
          appId: "com.acme.linear",
          slug: "linear",
          name: "Linear",
          path: "skills/create-issue",
          skillPath: "/tmp/SKILL.md",
          enabled: true,
          scope: "app:other",
        },
      ]),
    ).rejects.toThrow("attribution");
  });
});
