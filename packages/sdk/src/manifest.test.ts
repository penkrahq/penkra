import { describe, expect, it } from "vitest";

import { defineApp, validateAppManifest } from "./manifest";

const validManifest = {
  manifestVersion: 1,
  id: "com.penkra.apps",
  slug: "apps",
  name: "Apps",
  summary: "Discover and manage Penkra Apps.",
  version: "0.1.0",
  compatibility: { penkra: ">=0.8.0" },
  icons: [{ src: "assets/icon.svg", sizes: "any", type: "image/svg+xml" }],
  entrypoints: { app: "app.html", operations: "operations.html" },
  permissions: [
    { name: "network-fetch", required: true, reason: "Load the Penkra App catalog." },
  ],
  operations: [
    {
      key: "installations.install",
      summary: "Install a registry App.",
      input: { type: "object" },
      output: { type: "object" },
      handler: "installations.install",
    },
  ],
} as const;

describe("validateAppManifest", () => {
  it("accepts the canonical Apps manifest shape", () => {
    expect(validateAppManifest(validManifest)).toEqual({ ok: true, manifest: validManifest });
    expect(defineApp(validManifest)).toBe(validManifest);
  });

  it("keeps App slug and operation key separate", () => {
    const result = validateAppManifest({
      ...validManifest,
      operations: [{ ...validManifest.operations[0], key: "apps.installations.install" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: "operations[0].key", code: "invalid-format" }),
    );
  });

  it("rejects unsafe entrypoints and duplicate declarations", () => {
    const result = validateAppManifest({
      ...validManifest,
      entrypoints: { app: "../app.html" },
      permissions: [validManifest.permissions[0], validManifest.permissions[0]],
      operations: [validManifest.operations[0], validManifest.operations[0]],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "entrypoints.app", code: "unsafe-path" }),
        expect.objectContaining({ path: "permissions[1].name", code: "duplicate" }),
        expect.objectContaining({ path: "operations[1].key", code: "duplicate" }),
      ]),
    );
  });

  it("rejects invalid public identifiers", () => {
    const result = validateAppManifest({
      ...validManifest,
      id: "penkra-apps",
      slug: "Penkra Apps",
      permissions: [{ ...validManifest.permissions[0], name: "network.fetch" }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "id", code: "invalid-format" }),
        expect.objectContaining({ path: "slug", code: "invalid-format" }),
        expect.objectContaining({ path: "permissions[0].name", code: "invalid-format" }),
      ]),
    );
  });

  it("requires a controller entrypoint when operations are declared", () => {
    const result = validateAppManifest({
      ...validManifest,
      entrypoints: { app: "app.html" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: "entrypoints.operations", code: "missing" }),
    );
  });

  it("rejects undeclared host authority instead of accepting arbitrary permission names", () => {
    const result = validateAppManifest({
      ...validManifest,
      permissions: [{ name: "account-read", required: false, reason: "Read the account" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContainEqual(expect.objectContaining({
      path: "permissions[0].name",
      message: "account-read is not a supported Penkra permission.",
    }));
  });

  it("enforces the bounded local-reference JSON Schema profile", () => {
    const result = validateAppManifest({
      ...validManifest,
      operations: [{
        ...validManifest.operations[0],
        input: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: { value: { pattern: "(a+)+$" } },
          $ref: "https://example.com/shared.json",
        },
      }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "operations[0].input", message: expect.stringContaining("draft/2020-12") }),
      expect.objectContaining({ path: "operations[0].input", message: expect.stringContaining("pattern") }),
      expect.objectContaining({ path: "operations[0].input", message: expect.stringContaining("document-local") }),
    ]));
  });
});
