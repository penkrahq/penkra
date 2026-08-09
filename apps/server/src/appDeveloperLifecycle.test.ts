import { describe, expect, it, vi } from "vitest";

import { appPublicationStatus, publishAppDirectory } from "./appDeveloperLifecycle";
import type { AppPackageEvidence } from "./appDeveloperTools";

const digest = (character: string) => character.repeat(64);

function evidence(path: string, packageDigest = digest("a")): AppPackageEvidence {
  return {
    path,
    appId: "com.penkra.canvas",
    slug: "canvas",
    name: "Canvas",
    summary: "Collaborative design editor.",
    version: "0.1.1",
    compatibilityRange: ">=0.9.1",
    manifestDigest: digest("b"),
    readmeDigest: digest("c"),
    instructionsDigest: digest("d"),
    packageDigest,
    packageSizeBytes: 100,
    permissions: [],
  };
}

function dependencies(packageDigest = digest("a")) {
  return {
    test: vi.fn(async () => ({
      ok: true as const,
      appId: "com.penkra.canvas",
      version: "0.1.1",
      tab: { id: "tab-1", status: "ready" as const },
      diagnostics: [{ kind: "tab-ready" }],
      profileRemoved: true as const,
    })),
    package: vi.fn(async (input: { directory: string; output: string }) =>
      evidence(input.output, packageDigest),
    ),
    sign: vi.fn(async () => undefined),
  };
}

describe("registered App publication lifecycle", () => {
  it("accepts a manifest identifier when reporting one App's status", async () => {
    const bridge = vi.fn(async (method: string, params?: unknown) => {
      if (method === "developer.publishers.list") return [{ id: "publisher-1" }];
      if (method === "developer.apps.list") {
        return [{ id: "registry-app-1", identifier: "com.penkra.canvas" }];
      }
      if (method === "developer.submissions.list") return [{ version: "0.1.1" }];
      throw new Error(`Unexpected bridge method ${method}`);
    });

    await expect(appPublicationStatus("com.penkra.canvas", bridge)).resolves.toEqual({
      appId: "com.penkra.canvas",
      registryAppId: "registry-app-1",
      submissions: [{ version: "0.1.1" }],
    });
    expect(bridge).toHaveBeenCalledWith("developer.submissions.list", {
      appId: "registry-app-1",
    });
  });

  it("reports an unsubmitted manifest identifier without sending an invalid registry id", async () => {
    const bridge = vi.fn(async (method: string) => {
      if (method === "developer.publishers.list") return [];
      throw new Error(`Unexpected bridge method ${method}`);
    });

    await expect(appPublicationStatus("com.penkra.canvas", bridge)).resolves.toEqual({
      appId: "com.penkra.canvas",
      registryAppId: null,
      submissions: [],
    });
    expect(bridge).not.toHaveBeenCalledWith("developer.submissions.list", expect.anything());
  });

  it("checks collisions before signing and applies public visibility after submission", async () => {
    const order: string[] = [];
    const bridge = vi.fn(async (method: string) => {
      order.push(method);
      if (method === "developer.publishers.list") return [{ id: "publisher-1", slug: "penkra" }];
      if (method === "developer.apps.list") {
        return [{ id: "app-1", identifier: "com.penkra.canvas" }];
      }
      if (method === "developer.submissions.list") return [];
      if (method === "developer.submissions.create") return { submissionId: "submission-1" };
      if (method === "developer.apps.visibility.set") return { visibility: "public" };
      throw new Error(`Unexpected bridge method ${method}`);
    });
    const mocks = dependencies();

    await expect(
      publishAppDirectory({
        directory: "/workspace/canvas/dist",
        visibility: "public",
        bridge,
        dependencies: mocks,
      }),
    ).resolves.toMatchObject({
      resumed: false,
      package: { appId: "com.penkra.canvas", packageDigest: digest("a") },
      submission: { submissionId: "submission-1" },
    });
    expect(mocks.sign).toHaveBeenCalledOnce();
    expect(order.indexOf("developer.submissions.list")).toBeLessThan(
      order.indexOf("developer.submissions.create"),
    );
    expect(order.at(-1)).toBe("developer.apps.visibility.set");
  });

  it("resumes an exact immutable submission without signing or uploading again", async () => {
    const mocks = dependencies();
    const bridge = vi.fn(async (method: string) => {
      if (method === "developer.publishers.list") return [{ id: "publisher-1" }];
      if (method === "developer.apps.list") {
        return [{ id: "app-1", identifier: "com.penkra.canvas" }];
      }
      if (method === "developer.submissions.list") {
        return [
          {
            submissionId: "submission-1",
            version: "0.1.1",
            packageDigest: digest("a"),
          },
        ];
      }
      if (method === "developer.apps.visibility.set") return { visibility: "public" };
      throw new Error(`Unexpected bridge method ${method}`);
    });

    await expect(
      publishAppDirectory({
        directory: "/workspace/canvas/dist",
        visibility: "public",
        bridge,
        dependencies: mocks,
      }),
    ).resolves.toMatchObject({
      resumed: true,
      submission: { submissionId: "submission-1" },
    });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalledWith("developer.submissions.create", expect.anything());
  });

  it("rejects changed bytes under an existing version before signing or visibility mutation", async () => {
    const mocks = dependencies(digest("f"));
    const bridge = vi.fn(async (method: string) => {
      if (method === "developer.publishers.list") return [{ id: "publisher-1" }];
      if (method === "developer.apps.list") {
        return [{ id: "app-1", identifier: "com.penkra.canvas" }];
      }
      if (method === "developer.submissions.list") {
        return [{ version: "0.1.1", packageDigest: digest("a") }];
      }
      throw new Error(`Unexpected bridge method ${method}`);
    });

    await expect(
      publishAppDirectory({
        directory: "/workspace/canvas/dist",
        visibility: "public",
        bridge,
        dependencies: mocks,
      }),
    ).rejects.toMatchObject({ code: "APP_VERSION_EXISTS" });
    expect(mocks.sign).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalledWith("developer.apps.visibility.set", expect.anything());
  });
});
