import fs from "node:fs";
import path from "node:path";

const ignoredDirectoryNames = new Set([".git", ".penkra", "dist", "node_modules"]);
const parallelPlanningNames = new Set([
  "CANVAS-ARCHITECTURE.md",
  "CANVAS-NEXT.md",
  "PENKRA.md",
  "PLAN.md",
  "ROADMAP.md",
  "STORIES.md",
]);

export function findProductPlanViolations(repositoryRoot: string): string[] {
  const failures: string[] = [];
  const canonicalPlan = path.join(repositoryRoot, "TODO.md");
  if (!fs.existsSync(canonicalPlan)) {
    failures.push("Missing canonical repository planning document: TODO.md");
  }

  const pending = [repositoryRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && ignoredDirectoryNames.has(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
        continue;
      }

      const relativePath = path.relative(repositoryRoot, candidate);
      if (entry.name === "TODO.md" && relativePath !== "TODO.md") {
        failures.push(`Parallel repository planning authority: ${relativePath}`);
      } else if (parallelPlanningNames.has(entry.name)) {
        failures.push(`Forbidden parallel planning document: ${relativePath}`);
      }
    }
  }

  return failures;
}

function main(): void {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const failures = findProductPlanViolations(repositoryRoot);
  if (failures.length > 0) {
    throw new Error(
      `Product-plan consistency check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }

  console.log("Product-plan consistency check passed.");
}

if (import.meta.main) main();
