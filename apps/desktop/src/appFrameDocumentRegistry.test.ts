import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InstalledAppPackage } from "./appInstallationState";
import { AppFrameDocumentRegistry } from "./appFrameDocumentRegistry";
import { PENKRA_APP_SCHEME } from "./appRuntimePolicy";

const ORIGIN = `penkra-app://a-${"a".repeat(64)}`;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => FS.rm(root, { recursive: true, force: true })));
});

function installedApp(version = "1.0.0"): InstalledAppPackage {
  const manifest = {
    id: "com.penkra.apps",
    slug: "apps",
    name: "Apps",
    summary: "Manage Apps.",
    version,
    compatibility: { penkra: ">=0.8.0" },
    icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }],
    entrypoints: { tab: "app.html" },
  } as const;
  return {
    appId: manifest.id,
    slug: manifest.slug,
    name: manifest.name,
    summary: manifest.summary,
    version,
    source: "registry",
    packagePath: `/packages/apps/${version}`,
    sha256: (version === "1.0.0" ? "a" : "b").repeat(64),
    installedAt: "2026-08-01T00:00:00.000Z",
    manifest,
  };
}

describe("AppFrameDocumentRegistry", () => {
  it("registers one shell-session protocol and routes only active opaque origins", async () => {
    const protocol = {
      handle: vi.fn(
        async (_scheme: string, _handler: (request: Request) => Promise<Response>) => undefined,
      ),
      unhandle: vi.fn(async () => undefined),
    };
    const packageHandler = vi.fn(async () => new Response("app"));
    const createProtocolHandler = vi.fn(async () => packageHandler);
    const blobUrls = { resolve: vi.fn() };
    const transferHandler = vi.fn(async () => new Response("transfer"));
    const registry = new AppFrameDocumentRegistry({
      protocol: protocol as never,
      runtimeScriptPath: "/trusted/appFrameRuntime.iife.js",
      resolveOrigin: () => ORIGIN,
      createProtocolHandler,
      protocolResources: () => ({ blobUrls: blobUrls as never, transferHandler }),
    });

    await registry.start();
    await registry.start();
    expect(protocol.handle).toHaveBeenCalledOnce();
    expect(protocol.handle).toHaveBeenCalledWith(PENKRA_APP_SCHEME, expect.any(Function));

    const url = await registry.activate(installedApp(), "personal");
    expect(url).toBe(`${ORIGIN}/app.html?penkra-package=${"a".repeat(64)}`);
    expect(createProtocolHandler).toHaveBeenCalledWith({
      origin: ORIGIN,
      packageRoot: "/packages/apps/1.0.0",
      packageSha256: "a".repeat(64),
      entrypoint: "app.html",
      runtimeScriptPath: "/trusted/appFrameRuntime.iife.js",
      blobUrls,
      transferHandler,
    });
    const delegate = protocol.handle.mock.calls[0]?.[1] as
      | ((request: Request) => Promise<Response>)
      | undefined;
    if (!delegate) throw new Error("Expected protocol delegate.");
    await expect((await delegate(new Request(url))).text()).resolves.toBe("app");
    await expect(
      delegate(new Request(`penkra-app://a-${"b".repeat(64)}/app.html`)),
    ).resolves.toMatchObject({ status: 404 });

    expect(await registry.deactivate(installedApp().appId, "personal")).toBe(true);
    await expect(delegate(new Request(url))).resolves.toMatchObject({ status: 404 });
    await registry.dispose();
    expect(protocol.unhandle).toHaveBeenCalledWith(PENKRA_APP_SCHEME);
  });

  it("prepares an update before atomically replacing the active handler", async () => {
    const protocol = { handle: vi.fn(async () => undefined), unhandle: vi.fn() };
    const v1 = vi.fn(async () => new Response("v1"));
    const v2 = vi.fn(async () => new Response("v2"));
    const createProtocolHandler = vi.fn().mockResolvedValueOnce(v1).mockResolvedValueOnce(v2);
    const registry = new AppFrameDocumentRegistry({
      protocol: protocol as never,
      runtimeScriptPath: "/trusted/runtime.js",
      resolveOrigin: () => ORIGIN,
      createProtocolHandler,
    });
    await registry.start();
    const firstUrl = await registry.activate(installedApp(), "personal");
    const secondUrl = await registry.activate(installedApp("2.0.0"), "personal");
    expect(createProtocolHandler).toHaveBeenCalledTimes(2);
    expect(firstUrl).not.toBe(secondUrl);
    expect(secondUrl).toContain(`penkra-package=${"b".repeat(64)}`);
    expect(registry.getOrigin(installedApp().appId, "personal")).toBe(ORIGIN);
  });

  it("serves new bytes behind a stable origin for registry and sideload package revisions", async () => {
    const root = await FS.mkdtemp(Path.join(OS.tmpdir(), "penkra-frame-package-revision-"));
    roots.push(root);
    const v1Root = Path.join(root, "v1");
    const v2Root = Path.join(root, "v2");
    const runtimeScriptPath = Path.join(root, "runtime.js");
    await Promise.all([
      FS.mkdir(v1Root),
      FS.mkdir(v2Root),
      FS.writeFile(runtimeScriptPath, "globalThis.penkraRuntime = true;"),
    ]);
    await Promise.all([
      FS.writeFile(Path.join(v1Root, "app.html"), '<script src="/app.js"></script>'),
      FS.writeFile(Path.join(v1Root, "app.js"), "globalThis.visibleVersion = 'v1';"),
      FS.writeFile(Path.join(v2Root, "app.html"), '<script src="/app.js"></script>'),
      FS.writeFile(Path.join(v2Root, "app.js"), "globalThis.visibleVersion = 'v2';"),
    ]);
    let delegate: ((request: Request) => Promise<Response>) | null = null;
    const registry = new AppFrameDocumentRegistry({
      protocol: {
        handle: vi.fn(async (_scheme, handler) => {
          delegate = handler;
        }),
        unhandle: vi.fn(async () => undefined),
      } as never,
      runtimeScriptPath,
      resolveOrigin: () => ORIGIN,
    });
    await registry.start();
    if (!delegate) throw new Error("Expected the App package protocol delegate.");
    const handle = delegate as (request: Request) => Promise<Response>;

    const v1Url = await registry.activate(
      { ...installedApp(), packagePath: v1Root, source: "registry" },
      "personal",
    );
    const v1Script = await handle(new Request(`${ORIGIN}/app.js`));
    const v1EntityTag = v1Script.headers.get("etag");
    expect(v1Url).toContain(`penkra-package=${"a".repeat(64)}`);
    await expect(v1Script.text()).resolves.toContain("'v1'");

    const v2Url = await registry.activate(
      { ...installedApp("2.0.0"), packagePath: v2Root, source: "sideload" },
      "personal",
    );
    const v2Script = await handle(
      new Request(`${ORIGIN}/app.js`, {
        headers: { "if-none-match": v1EntityTag ?? "" },
      }),
    );
    expect(new URL(v2Url).origin).toBe(new URL(v1Url).origin);
    expect(v2Url).toContain(`penkra-package=${"b".repeat(64)}`);
    expect(v2Script.status).toBe(200);
    expect(v2Script.headers.get("etag")).toBe(`"penkra-package-${"b".repeat(64)}"`);
    await expect(v2Script.text()).resolves.toContain("'v2'");
  });
});
