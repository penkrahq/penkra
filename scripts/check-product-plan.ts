import fs from "node:fs";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const workspaceRoot = path.resolve(repositoryRoot, "..");
const repositories = ["penkra", "penkra-apps", "penkra-website", "penkra-backend"];
const forbiddenPlanningNames = new Set(["PENKRA.md", "STORIES.md", "TODO.md"]);
const failures: string[] = [];

for (const required of ["TODO.md", "ROADMAP.md"]) {
  if (!fs.existsSync(path.join(workspaceRoot, required))) {
    failures.push(`Missing authoritative root planning document: ${required}`);
  }
}

for (const repository of repositories) {
  const root = path.join(workspaceRoot, repository);
  if (!fs.existsSync(root)) continue;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (forbiddenPlanningNames.has(entry.name)) {
        failures.push(
          `Forbidden repository-local planning authority: ${path.relative(workspaceRoot, candidate)}`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  throw new Error(
    `Product-plan consistency check failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
  );
}

console.log("Product-plan consistency check passed.");
