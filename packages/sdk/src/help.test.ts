import { describe, expect, it } from "vitest";

import { generateAppHelp } from "./help";

const manifest = {
  manifestVersion: 2,
  id: "com.acme.linear",
  slug: "linear",
  name: "Linear",
  summary: "Manage issues.",
  version: "1.0.0",
  compatibility: { penkra: ">=0.8.0" },
  icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
  entrypoints: { app: "app.html", operations: "operations.html" },
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
      handler: "issues.create",
    },
  ],
} as const;

describe("generated App help", () => {
  it("combines package instructions with direct App-root commands", () => {
    const help = generateAppHelp({
      manifest,
      instructions: "Create issues only after confirming the project.",
    });
    expect(help).toContain("Linear (linear)");
    expect(help).toContain("Create issues only after confirming the project.");
    expect(help).toContain("penkra linear issues create");
  });

  it("renders concise required-first flags and hides raw schemas by default", () => {
    const help = generateAppHelp({
      manifest,
      instructions: "Follow workspace conventions.",
      operation: "issues.create",
    });
    expect(help).toContain("[--input '<json>'] [--<property> <value> ...] [--tab-id <tab-id>]");
    expect(help).toContain("--title <string>  required.");
    expect(help).toContain('--priority <string>  optional; default "low"; one of "low", "high".');
    expect(help).not.toContain('"required": [');
    expect(help).toContain("App instructions\nFollow workspace conventions.");
  });

  it("shows validated schemas only when explicitly requested", () => {
    const help = generateAppHelp({
      manifest,
      instructions: "Follow conventions.",
      operation: "issues.create",
      schema: true,
    });
    expect(help).toContain('"required": [');
    expect(help).toContain("Output schema");
  });
});
