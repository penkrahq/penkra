import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { findProductPlanViolations } from "./check-product-plan";

function withRepositoryFixture(run: (repositoryRoot: string) => void): void {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "penkra-product-plan-"));
  try {
    run(repositoryRoot);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
}

describe("product plan consistency", () => {
  it("accepts one canonical root TODO", () => {
    withRepositoryFixture((repositoryRoot) => {
      fs.writeFileSync(path.join(repositoryRoot, "TODO.md"), "# TODO\n");
      fs.mkdirSync(path.join(repositoryRoot, "docs"));
      fs.writeFileSync(path.join(repositoryRoot, "docs", "architecture.md"), "# Architecture\n");

      expect(findProductPlanViolations(repositoryRoot)).toEqual([]);
    });
  });

  it("rejects a missing canonical TODO and parallel planning documents", () => {
    withRepositoryFixture((repositoryRoot) => {
      fs.mkdirSync(path.join(repositoryRoot, "docs"));
      fs.writeFileSync(path.join(repositoryRoot, "ROADMAP.md"), "# Roadmap\n");
      fs.writeFileSync(path.join(repositoryRoot, "docs", "TODO.md"), "# Other TODO\n");

      expect(findProductPlanViolations(repositoryRoot)).toEqual([
        "Missing canonical repository planning document: TODO.md",
        "Forbidden parallel planning document: ROADMAP.md",
        path.join("Parallel repository planning authority: docs", "TODO.md"),
      ]);
    });
  });

  it("ignores generated, dependency, Git, and task-scratch directories", () => {
    withRepositoryFixture((repositoryRoot) => {
      fs.writeFileSync(path.join(repositoryRoot, "TODO.md"), "# TODO\n");
      for (const directory of [".git", ".penkra", "dist", "node_modules"]) {
        fs.mkdirSync(path.join(repositoryRoot, directory));
        fs.writeFileSync(path.join(repositoryRoot, directory, "ROADMAP.md"), "# Generated\n");
      }

      expect(findProductPlanViolations(repositoryRoot)).toEqual([]);
    });
  });
});
