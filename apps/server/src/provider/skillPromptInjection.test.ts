// FILE: skillPromptInjection.test.ts
// Purpose: Verifies which providers receive inlined portable skill instructions
//          and that the inline text respects the turn character budget.
// Layer: Server provider tests

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildInlineSkillInstructions,
  shouldInlineSkillForProvider,
} from "./skillPromptInjection.ts";

const penkraSkillPath = "/Users/me/.penkra/skills/reviewer/SKILL.md";
const codexSkillPath = "/Users/me/.codex/skills/reviewer/SKILL.md";
const claudeSkillPath = "/Users/me/.claude/skills/reviewer/SKILL.md";

describe("shouldInlineSkillForProvider", () => {
  it("skips codex-native and penkra roots for codex but inlines foreign provider roots", () => {
    // Codex loads .codex roots natively and ~/.penkra/skills via the extra
    // skill root registered at session start.
    expect(shouldInlineSkillForProvider("codex", penkraSkillPath)).toBe(false);
    expect(shouldInlineSkillForProvider("codex", codexSkillPath)).toBe(false);
    expect(shouldInlineSkillForProvider("codex", claudeSkillPath)).toBe(true);
  });

  it("inlines everything except .claude paths for claudeAgent", () => {
    expect(shouldInlineSkillForProvider("claudeAgent", claudeSkillPath)).toBe(false);
    expect(shouldInlineSkillForProvider("claudeAgent", penkraSkillPath)).toBe(true);
    expect(shouldInlineSkillForProvider("claudeAgent", codexSkillPath)).toBe(true);
  });

  it("always inlines for OpenCode", () => {
    expect(shouldInlineSkillForProvider("opencode", penkraSkillPath)).toBe(true);
    expect(shouldInlineSkillForProvider("opencode", claudeSkillPath)).toBe(true);
  });
});

describe("buildInlineSkillInstructions", () => {
  it("inlines skill content for non-native providers and skips unreadable paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-inline-"));
    const skillDir = path.join(root, ".penkra", "skills", "reviewer");
    try {
      await mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      await writeFile(skillPath, "# Reviewer\n\nAlways review carefully.");

      const text = await buildInlineSkillInstructions({
        provider: "opencode",
        skills: [
          { name: "reviewer", path: skillPath },
          { name: "missing", path: path.join(root, ".penkra", "skills", "missing", "SKILL.md") },
        ],
        maxChars: 10_000,
      });

      expect(text).toContain('<skill name="reviewer"');
      expect(text).toContain("Always review carefully.");
      expect(text).not.toContain("missing");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns empty text when nothing fits in the budget", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "skill-inline-budget-"));
    const skillDir = path.join(root, ".penkra", "skills", "reviewer");
    try {
      await mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      await writeFile(skillPath, "content".repeat(100));

      const text = await buildInlineSkillInstructions({
        provider: "opencode",
        skills: [{ name: "reviewer", path: skillPath }],
        maxChars: 50,
      });

      expect(text).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not inline penkra-rooted skills for codex (covered by the extra skill root)", async () => {
    const text = await buildInlineSkillInstructions({
      provider: "codex",
      skills: [{ name: "reviewer", path: penkraSkillPath }],
      maxChars: 10_000,
    });
    expect(text).toBe("");
  });
});
