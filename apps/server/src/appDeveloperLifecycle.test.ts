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
      help: { root: true as const, operations: ["documents.execute"] },
      tab: { id: "tab-1", status: "ready" as const },
      diagnostics: [{ kind: "tab-ready" }],
      profileRemoved: true as const,
    })),
    package: vi.fn(async (input: { directory: string; output: string }) =>
      evidence(input.output, packageDigest),
    ),
  };
}

describe("registered App publication lifecycle", () => {
  it("accepts a manifest identifier when reporting one App's status", async () => {
    const bridge = vi.fn(async (method: string, params?: unknown) => {
      if (method === "developer.publishers.list") return [{ id: "publisher-1" }];
      if (method === "developer.apps.list") {
        return [{ id: "registry-app-1", identifier: "com.penkra.canvas" }];
      }
      if (method === "developer.submissions.list") {
        return [{ submissionId: "submission-1", version: "0.1.1", status: "published" }];
      }
      throw new Error(`Unexpected bridge method ${method}`);
    });

    await expect(appPublicationStatus("com.penkra.canvas", bridge)).resolves.toEqual({
      appId: "com.penkra.canvas",
      registryAppId: "registry-app-1",
      submissions: [{ submissionId: "submission-1", version: "0.1.1", status: "published" }],
    });
    expect(bridge).toHaveBeenCalledWith("developer.submissions.list", {
      appId: "registry-app-1",
    });
    expect(bridge).not.toHaveBeenCalledWith("developer.submissions.get", expect.anything());
  });

  it("enriches failed and nonterminal submissions with exact validator findings", async () => {
    const summary = {
      submissionId: "submission-1",
      version: "0.2.6",
      packageDigest: digest("a"),
      status: "validation-failed",
      failure: {
        code: "AUTOMATED_VALIDATION_FAILED",
        detail: "manifest, identity, version, compatibility, permissions",
      },
    };
    const validations = [
      {
        validator: "manifest",
        status: "failed",
        findings: [
          {
            code: "invalid-manifest",
            message: 'Unrecognized key: "instructions"',
            path: "operations.0",
          },
        ],
      },
      ...["identity", "version", "compatibility", "permissions"].map((validator) => ({
        validator,
        status: "failed",
        findings: [
          {
            code: "dependency-failed",
            message: "Validation could not run because manifest is invalid.",
          },
        ],
      })),
    ];
    const bridge = vi.fn(async (method: string) => {
      if (method === "developer.publishers.list") return [{ id: "publisher-1" }];
      if (method === "developer.apps.list") {
        return [{ id: "registry-app-1", identifier: "com.penkra.apps" }];
      }
      if (method === "developer.submissions.list") return [summary];
      if (method === "developer.submissions.get") {
        return { ...summary, validations };
      }
      throw new Error(`Unexpected bridge method ${method}`);
    });

    await expect(appPublicationStatus("com.penkra.apps", bridge)).resolves.toEqual({
      appId: "com.penkra.apps",
      registryAppId: "registry-app-1",
      submissions: [{ ...summary, validations }],
    });
    expect(bridge).toHaveBeenCalledWith("developer.submissions.get", {
      submissionId: "submission-1",
    });
  });

  it("retains submission history when a detail lookup fails", async () => {
    const summary = {
      submissionId: "submission-1",
      version: "0.2.6",
      status: "validating",
    };
    const bridge = vi.fn(async (method: string) => {
      if (method === "developer.publishers.list") return [{ id: "publisher-1" }];
      if (method === "developer.apps.list") {
        return [{ id: "registry-app-1", identifier: "com.penkra.apps" }];
      }
      if (method === "developer.submissions.list") return [summary];
      if (method === "developer.submissions.get") throw new Error("Registry detail unavailable");
      throw new Error(`Unexpected bridge method ${method}`);
    });

    await expect(appPublicationStatus("com.penkra.apps", bridge)).resolves.toEqual({
      appId: "com.penkra.apps",
      registryAppId: "registry-app-1",
      submissions: [
        {
          ...summary,
          detailError: { message: "Registry detail unavailable" },
        },
      ],
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

  it("checks collisions before upload and applies public visibility after submission", async () => {
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
    expect(order.indexOf("developer.submissions.list")).toBeLessThan(
      order.indexOf("developer.submissions.create"),
    );
    expect(order.at(-1)).toBe("developer.apps.visibility.set");
  });

  it("resumes an exact immutable submission without uploading again", async () => {
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
    expect(bridge).not.toHaveBeenCalledWith("developer.submissions.create", expect.anything());
  });

  it("resumes the exact immutable bytes for a draft whose upload did not finish", async () => {
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
            status: "draft",
          },
        ];
      }
      if (method === "developer.submissions.resume-upload") {
        return { submissionId: "submission-1", status: "uploaded" };
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
      submission: { submissionId: "submission-1", status: "uploaded" },
    });
    expect(bridge).toHaveBeenCalledWith("developer.submissions.resume-upload", {
      submissionId: "submission-1",
      packagePath: expect.stringMatching(/app\.penkra$/),
      evidence: expect.objectContaining({ packageDigest: digest("a") }),
    });
    expect(bridge).not.toHaveBeenCalledWith("developer.submissions.create", expect.anything());
  });

  it.each(["VALIDATION_INFRASTRUCTURE_FAILED", "AUTOMATED_VALIDATION_FAILED"])(
    "retries %s validation for the exact immutable submission",
    async (failureCode) => {
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
              status: "validation-failed",
              failure: { code: failureCode, detail: "validation failed" },
            },
          ];
        }
        if (method === "developer.submissions.retry-validation") {
          return { submissionId: "submission-1", status: "uploaded" };
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
        submission: { submissionId: "submission-1", status: "uploaded" },
      });
      expect(bridge).toHaveBeenCalledWith("developer.submissions.retry-validation", {
        submissionId: "submission-1",
      });
      expect(bridge).not.toHaveBeenCalledWith("developer.submissions.create", expect.anything());
    },
  );

  it("retries infrastructure publication for the exact prepared release", async () => {
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
            status: "publication-failed",
            failure: { code: "RELEASE_PUBLICATION_FAILED", detail: "release storage failed" },
          },
        ];
      }
      if (method === "developer.submissions.retry-publication") {
        return { submissionId: "submission-1", status: "ready" };
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
      submission: { submissionId: "submission-1", status: "ready" },
    });
    expect(bridge).toHaveBeenCalledWith("developer.submissions.retry-publication", {
      submissionId: "submission-1",
    });
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
    expect(bridge).not.toHaveBeenCalledWith("developer.apps.visibility.set", expect.anything());
  });
});
