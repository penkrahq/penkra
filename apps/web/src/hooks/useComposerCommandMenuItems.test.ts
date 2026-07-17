import { describe, expect, it } from "vitest";

import { buildSkillCommandItems } from "./useComposerCommandMenuItems";

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
        { name: "document-intake", description: "Store client documents durably" },
        { name: "business-setup", description: "Register a business" },
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
        },
        label: "document-intake",
        description: "Store client documents durably",
      },
    ]);
  });

  it("keeps provider-local skills when Penkra has no record with that name", () => {
    const items = buildSkillCommandItems(
      [{ ...providerSkill, name: "check-code" }],
      [{ name: "business-setup", description: "Register a business" }],
      "check",
    );

    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("skill");
  });
});
