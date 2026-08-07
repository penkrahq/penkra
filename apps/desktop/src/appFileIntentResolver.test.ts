import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createEmptyAppInstallationState,
  registerVerifiedAppPackage,
  setSpaceAppEnabled,
  type AppInstallationState,
} from "./appInstallationState";
import { resolveFileIntent } from "./appFileIntentResolver";
import { AppIntentRouter } from "./appIntentRouter";
import { AppOpenWithPreferenceStore } from "./appOpenWithPreferences";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => FS.promises.rm(directory, { recursive: true, force: true })),
  );
});

function addFileApp(
  state: AppInstallationState,
  id: string,
  slug: string,
  extensions: string[],
): AppInstallationState {
  let next = registerVerifiedAppPackage(
    state,
    {
      manifest: {
        manifestVersion: 1,
        id,
        slug,
        name: slug,
        summary: "Open files.",
        version: "1.0.0",
        compatibility: { penkra: ">=0.8.0" },
        icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
        entrypoints: { app: "app.html", operations: "operations.html" },
        operations: [
          {
            key: "files.open",
            summary: "Open a file.",
            input: { type: "object" },
            output: { type: "object" },
            handler: "files.open",
          },
        ],
        contributions: {
          handlers: [{ intent: "open-file", operation: "files.open", extensions }],
        },
      },
      source: "registry",
      packagePath: `/apps/${id}`,
      sha256: "d".repeat(64),
      installedAt: "2026-08-05T00:00:00.000Z",
    },
    "personal",
  );
  next = setSpaceAppEnabled(next, { appId: id, spaceId: "personal", enabled: true });
  return next;
}

async function fixture(name: string, bytes: string | Uint8Array) {
  const directory = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-file-intent-"));
  temporaryDirectories.push(directory);
  const path = Path.join(directory, name);
  await FS.promises.writeFile(path, bytes);
  return path;
}

async function preferences(directory: string) {
  return AppOpenWithPreferenceStore.open(Path.join(directory, "open-with-v2.json"));
}

describe("file intent resolution", () => {
  it.each([".env", ".env.local", "Dockerfile", "Makefile", "notes.unknown"])(
    "routes unclaimed UTF-8 text %s through the existing .txt handler",
    async (name) => {
      const path = await fixture(name, "KEY=value\n");
      const directory = Path.dirname(path);
      const state = addFileApp(
        createEmptyAppInstallationState(),
        "com.penkra.explorer",
        "explorer",
        [".txt"],
      );

      await expect(
        resolveFileIntent({
          intents: new AppIntentRouter(() => state),
          openWith: await preferences(directory),
          path,
          spaceId: "personal",
        }),
      ).resolves.toMatchObject({ slug: "explorer" });
    },
  );

  it("uses an exact specialized handler before text fallback", async () => {
    const path = await fixture("drawing.pen", '{"version":1}\n');
    let state = addFileApp(createEmptyAppInstallationState(), "com.penkra.explorer", "explorer", [
      ".txt",
    ]);
    state = addFileApp(state, "com.penkra.canvas", "canvas", [".pen"]);

    await expect(
      resolveFileIntent({
        intents: new AppIntentRouter(() => state),
        openWith: await preferences(Path.dirname(path)),
        path,
        spaceId: "personal",
      }),
    ).resolves.toMatchObject({ slug: "canvas" });
  });

  it("does not replace ambiguous exact handlers with the text handler", async () => {
    const path = await fixture("document.pdf", "plain text despite its extension");
    let state = addFileApp(createEmptyAppInstallationState(), "com.penkra.explorer", "explorer", [
      ".txt",
      ".pdf",
    ]);
    state = addFileApp(state, "com.example.pdf", "pdf", [".pdf"]);

    await expect(
      resolveFileIntent({
        intents: new AppIntentRouter(() => state),
        openWith: await preferences(Path.dirname(path)),
        path,
        spaceId: "personal",
      }),
    ).resolves.toBeNull();
  });

  it("leaves unclaimed binary files for the system", async () => {
    const path = await fixture("archive.bin", new Uint8Array([0, 1, 2, 3]));
    const state = addFileApp(createEmptyAppInstallationState(), "com.penkra.explorer", "explorer", [
      ".txt",
    ]);

    await expect(
      resolveFileIntent({
        intents: new AppIntentRouter(() => state),
        openWith: await preferences(Path.dirname(path)),
        path,
        spaceId: "personal",
      }),
    ).resolves.toBeNull();
  });

  it("does not reject a bounded text prefix ending inside a multi-byte character", async () => {
    const path = await fixture("large.env", `${"a".repeat(64 * 1024 - 1)}€rest`);
    const state = addFileApp(createEmptyAppInstallationState(), "com.penkra.explorer", "explorer", [
      ".txt",
    ]);

    await expect(
      resolveFileIntent({
        intents: new AppIntentRouter(() => state),
        openWith: await preferences(Path.dirname(path)),
        path,
        spaceId: "personal",
      }),
    ).resolves.toMatchObject({ slug: "explorer" });
  });

  it("honors the saved .txt preference for extensionless text", async () => {
    const path = await fixture("Dockerfile", "FROM scratch\n");
    let state = addFileApp(createEmptyAppInstallationState(), "com.penkra.explorer", "explorer", [
      ".txt",
    ]);
    state = addFileApp(state, "com.example.text", "text", [".txt"]);
    const openWith = await preferences(Path.dirname(path));
    await openWith.set("personal", "open-file", "com.example.text", ".txt");

    await expect(
      resolveFileIntent({
        intents: new AppIntentRouter(() => state),
        openWith,
        path,
        spaceId: "personal",
      }),
    ).resolves.toMatchObject({ slug: "text" });
  });
});
