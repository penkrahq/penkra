import { EventEmitter } from "node:events";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DownloadItem, Session } from "electron";
import { AppStorageService } from "./appStorage";
import { AppBrowserDownloadManager } from "./appBrowserDownloadManager";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

class Item extends EventEmitter {
  path = "";
  bytes = 0;
  paused = false;
  cancelled = false;
  constructor(readonly url = "https://example.test/file") {
    super();
  }
  getURL() {
    return this.url;
  }
  getFilename() {
    return "file.bin";
  }
  getMimeType() {
    return "application/octet-stream";
  }
  getURLChain() {
    return [this.url];
  }
  getETag() {
    return "etag";
  }
  getLastModifiedTime() {
    return "Wed, 21 Oct 2015 07:28:00 GMT";
  }
  getSavePath() {
    return this.path;
  }
  setSavePath(path: string) {
    this.path = path;
  }
  getReceivedBytes() {
    return this.bytes;
  }
  getTotalBytes() {
    return 100;
  }
  getCurrentBytesPerSecond() {
    return 10;
  }
  isPaused() {
    return this.paused;
  }
  canResume() {
    return true;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  cancel() {
    this.cancelled = true;
  }
  native() {
    return this as unknown as DownloadItem;
  }
}

function fixture() {
  const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "penkra-download-test-"));
  roots.push(root);
  const storage = new AppStorageService(root, 0);
  const session = { createInterruptedDownload: vi.fn(), downloadURL: vi.fn() };
  const publish = vi.fn();
  const owner = { appId: "com.example.browser", spaceId: "one" };
  const create = () =>
    new AppBrowserDownloadManager(root, owner, storage, session as unknown as Session, publish);
  return { root, storage, session, publish, create, owner };
}

describe("App browser downloads", () => {
  it("reserves distinct destinations for concurrent files with the same suggested name", () => {
    const manager = fixture().create();
    const first = new Item("https://example.test/first");
    const second = new Item("https://example.test/second");
    manager.admit(first.native(), "page");
    manager.admit(second.native(), "page");
    expect(first.path).not.toBe(second.path);
    expect(Path.basename(second.path)).toBe("file-1.bin");
  });
  it("publishes progress and explicitly reveals a duplicate without saving it", () => {
    const { create, publish } = fixture();
    const manager = create();
    const first = new Item();
    manager.admit(first.native(), "page");
    const id = manager.list()[0]!.id;
    first.bytes = 30;
    first.emit("updated", {}, "progressing");
    expect(manager.list()[0]).toMatchObject({ receivedBytes: 30, totalBytes: 100, secondsLeft: 7 });
    expect(publish.mock.lastCall?.[0].revealId).toBeUndefined();
    const duplicate = new Item();
    manager.admit(duplicate.native(), "page");
    expect(duplicate.cancelled).toBe(true);
    expect(duplicate.path).toBe("");
    expect(manager.list()).toHaveLength(1);
    expect(publish.mock.lastCall?.[0].revealId).toBe(id);
    manager.pause(id);
    expect(manager.list()[0]!.state).toBe("paused");
    manager.resume(id);
    first.emit("done", {}, "completed");
    expect(manager.pathForCompleted(id)).toBe(first.path);
    manager.clearFinished();
    expect(manager.list()).toEqual([]);
  });

  it("marks interrupted active downloads failed on restart and scopes history to the owner", () => {
    const { create, root, storage, session, publish } = fixture();
    const first = new Item();
    create().admit(first.native(), "page");
    const restored = create();
    expect(restored.list()[0]!.state).toBe("failed");
    const other = new AppBrowserDownloadManager(
      root,
      { appId: "com.example.browser", spaceId: "two" },
      storage,
      session as unknown as Session,
      publish,
    );
    expect(other.list()).toEqual([]);
  });

  it("preserves partial bytes on quit and restores the final name after resuming", () => {
    const { create, session } = fixture();
    const original = create();
    const item = new Item();
    original.admit(item.native(), "page");
    const id = original.list()[0]!.id;
    FS.writeFileSync(item.path, "0123456789");
    item.bytes = 10;
    item.emit("updated", {}, "progressing");
    original.prepareForQuit();
    item.emit("done", {}, "cancelled");
    const restored = create();
    expect(restored.list()[0]).toMatchObject({ state: "failed", receivedBytes: 10 });
    restored.retry(id);
    const options = session.createInterruptedDownload.mock.lastCall?.[0];
    expect(options.path).not.toBe(item.path);
    expect(FS.readFileSync(options.path, "utf8")).toBe("0123456789");
    const resumed = new Item();
    resumed.path = options.path;
    expect(restored.admitRetry(resumed.native())).toBe(true);
    resumed.bytes = 10;
    resumed.emit("done", {}, "completed");
    expect(restored.pathForCompleted(id)).toBe(item.path);
    expect(FS.readFileSync(item.path, "utf8")).toBe("0123456789");
  });

  it("keeps an explicit cancellation distinct from quit interruption", () => {
    const { create } = fixture();
    const manager = create();
    const item = new Item();
    manager.admit(item.native(), "page");
    manager.cancel(manager.list()[0]!.id);
    manager.prepareForQuit();
    item.emit("done", {}, "cancelled");
    expect(create().list()[0]!.state).toBe("cancelled");
  });

  it("resumes a retained partial file and starts over if no partial exists", () => {
    const { create, session } = fixture();
    const manager = create();
    const first = new Item();
    manager.admit(first.native(), "page");
    const id = manager.list()[0]!.id;
    FS.writeFileSync(first.path, "0123456789");
    first.bytes = 10;
    first.emit("updated", {}, "progressing");
    first.emit("done", {}, "interrupted");
    manager.retry(id);
    expect(() => manager.retry(id)).toThrow("Download retry is already starting.");
    manager.clearFinished();
    expect(manager.list()).toHaveLength(1);
    expect(session.createInterruptedDownload).toHaveBeenCalledWith(
      expect.objectContaining({ path: first.path, offset: 10, length: 100 }),
    );
    const resumed = new Item();
    resumed.path = first.path;
    expect(manager.admitRetry(resumed.native())).toBe(true);
    resumed.emit("done", {}, "cancelled");
    FS.unlinkSync(first.path);
    manager.retry(id);
    expect(session.downloadURL).toHaveBeenCalledWith(first.url);
    const restarted = new Item();
    expect(manager.admitRetry(restarted.native())).toBe(true);
    expect(restarted.path).toBeTruthy();
  });

  it("reveals an existing active download when retrying an older matching URL", () => {
    const { create, publish, session } = fixture();
    const manager = create();
    const failed = new Item();
    manager.admit(failed.native(), "page");
    const oldId = manager.list()[0]!.id;
    failed.emit("done", {}, "interrupted");
    const active = new Item();
    manager.admit(active.native(), "page");
    const activeId = manager.list()[0]!.id;
    manager.retry(oldId);
    expect(publish.mock.lastCall?.[0].revealId).toBe(activeId);
    expect(session.downloadURL).not.toHaveBeenCalled();
    expect(session.createInterruptedDownload).not.toHaveBeenCalled();
  });
});
