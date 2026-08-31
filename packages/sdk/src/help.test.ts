import { describe, expect, it } from "vitest";

import { assembleInstructions, generateAppHelp } from "./help";

const manifest = {
  id: "com.acme.linear",
  slug: "linear",
  name: "Linear",
  summary: "Manage issues.",
  version: "1.0.0",
  compatibility: { penkra: ">=0.8.0" },
  icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
  entrypoints: { tab: "app.html", controller: "operations.js" },
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
    expect(help).toContain("Invocation\n  Send one ordinary command string.");
    expect(help).toContain("--input   Complete JSON operation input");
    expect(help).toContain("How to use this operation");
    expect(help).toContain("Confirm the destination project");
    expect(help).toContain("Run linear --help for Linear operating instructions.");
    expect(help).not.toContain("Follow workspace conventions.");
  });

  it("renders resolved file-backed guidance in the same leaf-help position", () => {
    const { instructions: _inlineInstructions, ...operation } = manifest.operations[0];
    const fileBacked = {
      ...manifest,
      operations: [
        {
          ...operation,
          instructionsPath: "operations/issues.create.md",
        },
      ],
    } as const;
    const help = generateAppHelp({
      manifest: fileBacked,
      instructions: "Root guidance.",
      operation: "issues.create",
      operationInstructions: "Use the current project ID.\n\nRecover by listing projects again.",
    });
    expect(help).toContain("How to use this operation");
    expect(help).toContain("Use the current project ID.");
    expect(help.indexOf("How to use this operation")).toBeLessThan(help.indexOf("Examples"));
    expect(help).not.toContain("Root guidance.");
  });
});
