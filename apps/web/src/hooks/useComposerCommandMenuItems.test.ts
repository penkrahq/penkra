import { describe, expect, it } from "vitest";

import { buildMentionCommandItems, buildSkillCommandItems } from "./useComposerCommandMenuItems";

describe("buildSkillCommandItems", () => {
  const providerSkill = {
    name: "document-intake",
    description: "Stale local copy",
    path: "/workspace/.codex/skills/document-intake/SKILL.md",
    enabled: true,
    scope: "project" as const,
  };

  it("puts matching Penkra records first and suppresses stale local duplicates", () => {
    const items = buildSkillCommandItems(
      [providerSkill],
      [
        { scope: "client", name: "document-intake", description: "Store client documents durably" },
        { scope: "client", name: "business-setup", description: "Register a business" },
      ],
      "document",
    );

    expect(items).toEqual([
      {
        id: "penkra-skill:document-intake",
        type: "penkra-skill",
        skill: {
          name: "document-intake",
          description: "Store client documents durably",
          scope: "client",
        },
        label: "document-intake",
        description: "Store client documents durably",
      },
    ]);
  });

  it("keeps provider-local skills when Penkra has no record with that name", () => {
    const items = buildSkillCommandItems(
      [{ ...providerSkill, name: "check-code" }],
      [{ scope: "client", name: "business-setup", description: "Register a business" }],
      "check",
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("skill");
  });

  it("puts an HQ skill above a provider result for a $ query", () => {
    const items = buildSkillCommandItems(
      [{ ...providerSkill, name: "db-migration", path: "/workspace/db-migration.md" }],
      [{ scope: "hq", name: "db-migration", description: "Apply safe database migrations" }],
      "db-mig",
    );
    expect(items[0]).toMatchObject({ type: "penkra-skill", label: "db-migration" });
  });
});

describe("composer skill discovery lanes", () => {
  const providerSkill = {
    name: "check-code",
    description: "Review the current changes",
    path: "/workspace/.codex/skills/check-code/SKILL.md",
    enabled: true,
    scope: "project" as const,
  };
  const penkraSkill = {
    scope: "hq" as const,
    name: "db-migration",
    description: "Apply safe database migrations",
  };

  it("does not return provider or Penkra skills from the @ mention lane", () => {
    expect(
      buildMentionCommandItems({
        provider: "codex",
        providerPlugins: [],
        workspaceEntries: [],
        dynamicAgents: [],
        query: "db-mig",
      }).some((item) => item.type === "skill" || item.type === "penkra-skill"),
    ).toBe(false);
  });

  it("returns provider and Penkra skills from the $ lane", () => {
    expect(
      buildSkillCommandItems([providerSkill], [penkraSkill], "").map((item) => item.type),
    ).toEqual(["penkra-skill", "skill"]);
  });
});
