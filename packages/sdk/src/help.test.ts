import { describe, expect, it } from "vitest";

import { generateAppHelp } from "./help";

const manifest = {
  manifestVersion: 1,
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
      input: { type: "object", required: ["title"] },
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

  it("renders operation usage and both declared schemas", () => {
    const help = generateAppHelp({
      manifest,
      instructions: "Follow workspace conventions.",
      operation: "issues.create",
    });
    expect(help).toContain("[--input '<json>'] [--<property> <value> ...] [--tab-id <tab-id>]");
    expect(help).toContain('"required": [');
    expect(help).toContain("App instructions\nFollow workspace conventions.");
  });
});
