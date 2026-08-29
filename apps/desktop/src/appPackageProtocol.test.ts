import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAppPackageProtocolHandler } from "./appPackageProtocol";
import { AppBlobUrlRegistry } from "./appBlobUrlRegistry";

const roots: string[] = [];
const APP_ORIGIN = `penkra-app://a-${"a".repeat(64)}`;
const OTHER_APP_ORIGIN = `penkra-app://a-${"b".repeat(64)}`;

async function packageFixture() {
  const root = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-app-package-"));
  roots.push(root);
  await FS.promises.mkdir(Path.join(root, "assets"));
  await FS.promises.writeFile(Path.join(root, "app.html"), "<main>Apps</main>");
  await FS.promises.writeFile(Path.join(root, "assets", "app.js"), "export const ready = true;");
  return root;
}

async function runtimeFixture(): Promise<string> {
  const root = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-app-runtime-"));
  roots.push(root);
  const path = Path.join(root, "runtime.js");
  await FS.promises.writeFile(path, "globalThis.runtimeReady = true;");
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => FS.promises.rm(root, { recursive: true })));
});

describe("App package protocol", () => {
  it("serves package files with restrictive security headers and correct content types", async () => {
    const root = await packageFixture();
    const handle = await createAppPackageProtocolHandler({
      origin: APP_ORIGIN,
      packageRoot: root,
      packageSha256: "a".repeat(64),
      entrypoint: "app.html",
    });

    const response = await handle(new Request(`${APP_ORIGIN}/assets/app.js`));
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("export const ready = true;");
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const contentSecurityPolicy = response.headers.get("content-security-policy");
    expect(contentSecurityPolicy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(contentSecurityPolicy).toContain("connect-src 'self'");
    expect(contentSecurityPolicy).not.toContain("connect-src http:");
    expect(contentSecurityPolicy).not.toContain("connect-src https:");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
    expect(response.headers.get("etag")).toBe(`"penkra-package-${"a".repeat(64)}"`);
  });

  it("revalidates cached package assets against the verified package revision", async () => {
    const root = await packageFixture();
    const v1Revision = "a".repeat(64);
    const v2Revision = "b".repeat(64);
    const v1 = await createAppPackageProtocolHandler({
      origin: APP_ORIGIN,
      packageRoot: root,
      packageSha256: v1Revision,
      entrypoint: "app.html",
    });
    const initial = await v1(new Request(`${APP_ORIGIN}/assets/app.js`));
    const v1EntityTag = initial.headers.get("etag");
    expect(v1EntityTag).toBe(`"penkra-package-${v1Revision}"`);

    const unchanged = await v1(
      new Request(`${APP_ORIGIN}/assets/app.js`, {
        headers: { "if-none-match": `W/${v1EntityTag}` },
      }),
    );
    expect(unchanged.status).toBe(304);
    await expect(unchanged.text()).resolves.toBe("");

    await FS.promises.writeFile(Path.join(root, "assets", "app.js"), "export const ready = 'v2';");
    const v2 = await createAppPackageProtocolHandler({
      origin: APP_ORIGIN,
      packageRoot: root,
      packageSha256: v2Revision,
      entrypoint: "app.html",
    });
    const replaced = await v2(
      new Request(`${APP_ORIGIN}/assets/app.js`, {
        headers: { "if-none-match": v1EntityTag ?? "" },
      }),
    );
    expect(replaced.status).toBe(200);
    expect(replaced.headers.get("etag")).toBe(`"penkra-package-${v2Revision}"`);
    await expect(replaced.text()).resolves.toBe("export const ready = 'v2';");
  });

  it("serves package HEAD requests without a body and rejects package mutations", async () => {
    const root = await packageFixture();
    const handle = await createAppPackageProtocolHandler({
      origin: APP_ORIGIN,
      packageRoot: root,
      packageSha256: "a".repeat(64),
      entrypoint: "app.html",
    });

    const head = await handle(new Request(`${APP_ORIGIN}/assets/app.js`, { method: "HEAD" }));
    expect(head.status).toBe(200);
    await expect(head.text()).resolves.toBe("");
    expect(head.headers.get("etag")).toBe(`"penkra-package-${"a".repeat(64)}"`);

    const mutation = await handle(new Request(`${APP_ORIGIN}/assets/app.js`, { method: "POST" }));
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get("allow")).toBe("GET, HEAD");
    expect(mutation.headers.get("cache-control")).toBe("no-store");
    expect(mutation.headers.has("etag")).toBe(false);
  });

  it("injects and serves the trusted frame runtime before package scripts", async () => {
    const root = await packageFixture();
    await FS.promises.writeFile(
      Path.join(root, "app.html"),
      '<html><head><script src="/assets/app.js"></script></head><body></body></html>',
    );
    const handle = await createAppPackageProtocolHandler({
      origin: APP_ORIGIN,
      packageRoot: root,
      packageSha256: "a".repeat(64),
      entrypoint: "app.html",
      runtimeScriptPath: await runtimeFixture(),
    });

    const document = await (await handle(new Request(`${APP_ORIGIN}/app.html`))).text();
    expect(document.indexOf("/.penkra/runtime.js")).toBeLessThan(
      document.indexOf("/assets/app.js"),
    );
    const runtime = await handle(new Request(`${APP_ORIGIN}/.penkra/runtime.js`));
    expect(runtime.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(runtime.headers.get("cache-control")).toBeNull();
    await expect(runtime.text()).resolves.toBe("globalThis.runtimeReady = true;");
  });

  it("serves verified package-local WebAssembly with its required MIME type", async () => {
    const root = await packageFixture();
    await FS.promises.writeFile(
      Path.join(root, "assets", "engine.wasm"),
      Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );
    const handle = await createAppPackageProtocolHandler({
      origin: APP_ORIGIN,
      packageRoot: root,
      packageSha256: "a".repeat(64),
      entrypoint: "app.html",
    });

    const response = await handle(new Request(`${APP_ORIGIN}/assets/engine.wasm`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect((await response.arrayBuffer()).byteLength).toBe(8);
  });

  it("streams App blob URLs with full, bounded, suffix, and unsatisfiable ranges", async () => {
    const root = await packageFixture();
    const media = Path.join(root, "movie.mp4");
    await FS.promises.writeFile(media, "0123456789");
    const blobUrls = new AppBlobUrlRegistry();
    const url = blobUrls.open(
      {
        appId: "com.example.video",
        spaceId: "space-1",
        threadId: "thread-1",
        tabId: "tab-1",
        rendererId: 4,
        origin: APP_ORIGIN,
      },
      await FS.promises.realpath(media),
    );
    const handle = await createAppPackageProtocolHandler({
      origin: APP_ORIGIN,
      packageRoot: root,
      packageSha256: "a".repeat(64),
      entrypoint: "app.html",
      blobUrls,
    });

    const full = await handle(new Request(url));
    expect(full.status).toBe(200);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-length")).toBe("10");
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(full.headers.get("cache-control")).toBeNull();
    await expect(full.text()).resolves.toBe("0123456789");

    const bounded = await handle(new Request(url, { headers: { range: "bytes=2-5" } }));
    expect(bounded.status).toBe(206);
    expect(bounded.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(bounded.headers.get("cache-control")).toBeNull();
    await expect(bounded.text()).resolves.toBe("2345");

    const suffix = await handle(new Request(url, { headers: { range: "bytes=-3" } }));
    expect(suffix.status).toBe(206);
    await expect(suffix.text()).resolves.toBe("789");

    const invalid = await handle(new Request(url, { headers: { range: "bytes=20-30" } }));
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */10");
  });

  it("rejects blob tokens presented from another App origin", async () => {
    const root = await packageFixture();
    const media = Path.join(root, "movie.mp4");
    await FS.promises.writeFile(media, "bytes");
    const blobUrls = new AppBlobUrlRegistry();
    const url = blobUrls.open(
      {
        appId: "com.example.video",
        spaceId: "space-1",
        threadId: "thread-1",
        tabId: "tab-1",
        rendererId: 4,
        origin: APP_ORIGIN,
      },
      await FS.promises.realpath(media),
    );
    const handle = await createAppPackageProtocolHandler({
      origin: OTHER_APP_ORIGIN,
      packageRoot: root,
      packageSha256: "a".repeat(64),
      entrypoint: "app.html",
      blobUrls,
    });

    const stolen = `${OTHER_APP_ORIGIN}${new URL(url).pathname}`;
    await expect(handle(new Request(stolen))).resolves.toMatchObject({ status: 404 });
  });

  it("streams blob ranges across multiple file-descriptor reads", async () => {
    const root = await packageFixture();
    const media = Path.join(root, "large.bin");
    const bytes = Uint8Array.from({ length: 160 * 1024 + 7 }, (_, index) => index % 251);
    await FS.promises.writeFile(media, bytes);
    const blobUrls = new AppBlobUrlRegistry();
    const url = blobUrls.open(
      {
        appId: "com.example.video",
        spaceId: "space-1",
        threadId: "thread-1",
        tabId: "tab-1",
        rendererId: 4,
        origin: APP_ORIGIN,
      },
      await FS.promises.realpath(media),
    );
    const handle = await createAppPackageProtocolHandler({
      origin: APP_ORIGIN,
      packageRoot: root,
      packageSha256: "a".repeat(64),
      entrypoint: "app.html",
      blobUrls,
    });

    const response = await handle(new Request(url, { headers: { range: "bytes=32761-147469" } }));
    expect(response.status).toBe(206);
    expect(response.headers.get("content-length")).toBe("114709");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(32761, 147470));
  });

  it("falls back to the App entrypoint only for extensionless client routes", async () => {
    const root = await packageFixture();
    const handle = await createAppPackageProtocolHandler({
      origin: APP_ORIGIN,
      packageRoot: root,
      packageSha256: "a".repeat(64),
      entrypoint: "app.html",
    });

    const route = await handle(new Request(`${APP_ORIGIN}/installed`));
    expect(route.status).toBe(200);
    await expect(route.text()).resolves.toBe("<main>Apps</main>");
    const missingAsset = await handle(new Request(`${APP_ORIGIN}/assets/missing.js`));
    expect(missingAsset.status).toBe(404);
    expect(missingAsset.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a generic 404 for another App origin and traversal attempts", async () => {
    const root = await packageFixture();
    const handle = await createAppPackageProtocolHandler({
      origin: APP_ORIGIN,
      packageRoot: root,
      packageSha256: "a".repeat(64),
      entrypoint: "app.html",
    });

    await expect(handle(new Request(`${OTHER_APP_ORIGIN}/app.html`))).resolves.toMatchObject({
      status: 404,
    });
    await expect(handle(new Request(`${APP_ORIGIN}/%2e%2e/secrets.txt`))).resolves.toMatchObject({
      status: 404,
    });
  });

  it("does not follow a package symlink outside the verified root", async () => {
    const root = await packageFixture();
    const outside = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-app-secret-"));
    roots.push(outside);
    await FS.promises.writeFile(Path.join(outside, "secret.txt"), "secret");
    await FS.promises.symlink(Path.join(outside, "secret.txt"), Path.join(root, "secret.txt"));
    const handle = await createAppPackageProtocolHandler({
      origin: APP_ORIGIN,
      packageRoot: root,
      packageSha256: "a".repeat(64),
      entrypoint: "app.html",
    });

    const response = await handle(new Request(`${APP_ORIGIN}/secret.txt`));
    expect(response.status).toBe(404);
  });

  it("refuses to activate a package without a valid entrypoint", async () => {
    const root = await packageFixture();
    await expect(
      createAppPackageProtocolHandler({
        origin: APP_ORIGIN,
        packageRoot: root,
        packageSha256: "a".repeat(64),
        entrypoint: "missing.html",
      }),
    ).rejects.toThrow();
  });
});
