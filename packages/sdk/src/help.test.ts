import { describe, expect, it } from "vitest";

import { assembleInstructions, generateAppHelp } from "./help";

const manifest = {
  manifestVersion: 2,
  id: "com.acme.linear",
  slug: "linear",
  name: "Linear",
  summary: "Manage issues.",
  version: "1.0.0",
  compatibility: { penkra: ">=0.8.0" },
  icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
  entrypoints: { app: "app.html", operations: "operations.js" },
  operations: [
    {
      key: "issues.create",
      summary: "Create an issue.",
      input: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          priority: { type: "string", enum: ["low", "high"], default: "low" },
        },
      },
      output: { type: "object", required: ["id"] },
      examples: [
        {
          name: "Create a high-priority issue",
          input: { title: "Fix redirect", priority: "high" },
        },
      ],
      instructions:
        "Confirm the destination project before creating the issue. If creation fails, do not retry without checking whether the issue already exists.",
      handler: "issues.create",
    },
  ],
} as const;

describe("generated App help", () => {
  it("renders operation summaries without hand-authored operation lists", () => {
    const help = assembleInstructions({
      document: "# Penkra\n\nRead the operation summaries.",
      operations: [{ command: "penkra threads list", summary: "List Threads." }],
    });
    expect(help).toContain("`penkra threads list` — List Threads.");
  });

  it("combines package instructions with direct App-root commands", () => {
    const help = generateAppHelp({
      manifest,
      instructions: "Create issues only after confirming the project.",
    });
    expect(help).toContain("Linear (linear)");
    expect(help).toContain("Create issues only after confirming the project.");
    expect(help).toContain("linear issues create");
    expect(help).not.toContain("penkra linear");
  });

  it("renders structured call examples, input fields, invocation controls, and complete schemas", () => {
    const help = generateAppHelp({
      manifest,
      instructions: "Follow workspace conventions.",
      operation: "issues.create",
    });
    expect(help).not.toContain("[--input '<json>']");
    expect(help).toContain("title <string>  required.");
    expect(help).toContain('priority <string>  optional; default "low"; one of "low", "high".');
    expect(help).toContain('"command": "linear issues create --input');
    expect(help).toContain('\\"title\\":\\"Fix redirect\\"');
    expect(help).toContain('"required": [');
    expect(help).toContain("Validated output schema");
    expect(help).toContain("Invocation\n  --input");
    expect(help).toContain("Instructions");
    expect(help).toContain("Confirm the destination project");
    expect(help).toContain("Run linear --help for Linear operating instructions.");
    expect(help).not.toContain("Follow workspace conventions.");
  });
});
