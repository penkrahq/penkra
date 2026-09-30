import { describe, expect, it } from "vitest";

import classification from "./diagnostics-terminal-classification.json";
import { inventoryFailureSites } from "./diagnostics-coverage";

const classes = new Set([
  "consumes",
  "deadline",
  "propagates",
  "rethrow",
  "scheduled",
  "validation",
]);

describe("terminal diagnostics failure classification", () => {
  it("classifies every current terminal site exactly once with evidence", () => {
    const root = classification.scope;
    const actual = inventoryFailureSites(import.meta.dirname + "/..", [root])
      .map((site) => `${site.file.slice(root.length + 1)}:${site.line}:${site.column}:${site.kind}`)
      .toSorted();
    const reviewed = Object.entries(classification.files).flatMap(([file, rows]) =>
      rows.map((row) => {
        expect(classes.has(row.class)).toBe(true);
        expect(row.evidence.length).toBeGreaterThanOrEqual(30);
        return `${file}:${row.at}`;
      }),
    );
    expect(new Set(reviewed).size).toBe(reviewed.length);
    expect(reviewed.toSorted()).toEqual(actual);
  }, 10_000);
});
