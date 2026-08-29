import { describe, expect, it } from "vitest";

import {
  addAppPackageRevisionToDocumentUrl,
  appPackageEntityTag,
  normalizeAppPackageRevision,
  requestAcceptsAppPackageEntityTag,
} from "./appPackageRevision";

describe("App package revision", () => {
  it("normalizes verified SHA-256 identities for URLs and entity tags", () => {
    const revision = "A".repeat(64);
    expect(normalizeAppPackageRevision(revision)).toBe("a".repeat(64));
    expect(appPackageEntityTag(revision)).toBe(`"penkra-package-${"a".repeat(64)}"`);
    expect(addAppPackageRevisionToDocumentUrl("penkra-app://assigned/app.html", revision)).toBe(
      `penkra-app://assigned/app.html?penkra-package=${"a".repeat(64)}`,
    );
  });

  it("rejects non-package revisions", () => {
    expect(() => normalizeAppPackageRevision("1.0.0")).toThrow("SHA-256");
    expect(() => normalizeAppPackageRevision("a".repeat(63))).toThrow("SHA-256");
  });

  it("accepts strong, weak, list, and wildcard validators for the current package", () => {
    const entityTag = appPackageEntityTag("a".repeat(64));
    expect(requestAcceptsAppPackageEntityTag(entityTag, entityTag)).toBe(true);
    expect(requestAcceptsAppPackageEntityTag(`W/${entityTag}`, entityTag)).toBe(true);
    expect(requestAcceptsAppPackageEntityTag(`"other", ${entityTag}`, entityTag)).toBe(true);
    expect(requestAcceptsAppPackageEntityTag("*", entityTag)).toBe(true);
    expect(requestAcceptsAppPackageEntityTag('"other"', entityTag)).toBe(false);
    expect(requestAcceptsAppPackageEntityTag(null, entityTag)).toBe(false);
  });
});
