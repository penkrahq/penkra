import { describe, expect, it } from "vitest";

import {
  findManagedLoginMethod,
  findStaticCredentialMethod,
  getProviderConnectionManifest,
} from "./providerConnectionManifests";

describe("provider Connection manifests", () => {
  it("keeps Codex credentials and its rebuildable rollout index Connection-scoped", () => {
    const environment = getProviderConnectionManifest("codex")?.buildStateEnvironment({
      profileRoot: "/connections/account-a",
      nativeStateRoot: "/native/thread-generation",
    });

    expect(environment?.overrides.CODEX_HOME).toBe("/connections/account-a/codex-home");
    expect(environment?.overrides.CODEX_SQLITE_HOME).toBe(
      "/connections/account-a/codex-sqlite-home",
    );
  });
});
