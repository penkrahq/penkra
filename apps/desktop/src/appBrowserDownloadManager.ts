import { createHash, randomUUID } from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import type { DownloadItem, Session } from "electron";
import type {
  AppBrowserDownload,
  AppBrowserDownloadEvent,
  AppBrowserDownloadsChange,
} from "@penkra/sdk";
import type { AppStorageOwner, AppStorageService } from "./appStorage";
import { prepareAppBrowserDownload } from "./appBrowserDownload";

type Saved = AppBrowserDownload & {
  pageId: string;
  suggestedName: string;
  mimeType: string;
  storagePath: string;
  urlChain: string[];
  eTag: string;
  lastModified: string;
  partialPath?: string;
};

/** Owns the downloads for one browser session (one App in one Space). */
export class AppBrowserDownloadManager {
  private readonly file: string;
  private records: Saved[];
  private readonly active = new Map<string, DownloadItem>();
  private readonly pending = new Map<string, string>();
  private readonly pendingRestart = new Map<string, string>();
  private readonly cancelling = new Set<string>();
  private shuttingDown = false;

  constructor(
    userDataPath: string,
    private readonly owner: AppStorageOwner,
    private readonly storage: AppStorageService,
    private readonly session: Session,
    private readonly publish: (
      change: AppBrowserDownloadsChange,
      legacy?: AppBrowserDownloadEvent,
    ) => void,
  ) {
    const key = createHash("sha256")
      .update(owner.appId)
      .update("\0")
      .update(owner.spaceId)
      .digest("hex");
    this.file = Path.join(userDataPath, "apps", "browser-downloads", `${key}.json`);
    try {
      const value: unknown = JSON.parse(FS.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) throw new Error("Invalid browser download records.");
      this.records = value as Saved[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.records = [];
    }
    let changed = false;
    for (const record of this.records) {
      if (record.state === "progressing" || record.state === "paused") {
        record.state = "failed";
        record.secondsLeft = null;
        changed = true;
      }
    }
    if (changed) this.save();
  }

  list(): AppBrowserDownload[] {
    return this.records.map(
      ({ id, fileName, url, path, state, receivedBytes, totalBytes, secondsLeft, startedAt }) => ({
        id,
        fileName,
        url,
        path,
        state,
        receivedBytes,
        totalBytes,
        secondsLeft,
        startedAt,
      }),
    );
  }

  admit(item: DownloadItem, pageId: string): void {
    const url = item.getURL();
    const starting = new Set([...this.pending.values(), ...this.pendingRestart.values()]);
    const existing = this.records.find(
      (entry) => entry.url === url && (this.active.has(entry.id) || starting.has(entry.id)),
    );
    if (existing) {
      item.cancel();
      this.emit(existing.id);
      return;
    }
    const destination = prepareAppBrowserDownload(
      this.storage,
      this.owner,
      item.getFilename(),
      this.reservedPaths(),
    );
    item.setSavePath(destination.path);
    const record: Saved = {
      id: randomUUID(),
      fileName: Path.basename(destination.path),
      url,
      path: destination.path,
      state: "progressing",
      receivedBytes: 0,
      totalBytes: null,
      secondsLeft: null,
      startedAt: new Date().toISOString(),
      pageId,
      suggestedName: item.getFilename(),
      mimeType: item.getMimeType(),
      storagePath: destination.storagePath,
      urlChain: item.getURLChain(),
      eTag: item.getETag(),
      lastModified: item.getLastModifiedTime(),
    };
    this.records.unshift(record);
    try {
      this.save();
    } catch (error) {
      this.records.shift();
      throw error;
    }
    this.bind(record, item);
    this.emit(record.id, this.legacy(record, "pending"));
  }

  /** Electron-created retries have no WebContents; match the stored destination. */
  admitRetry(item: DownloadItem): boolean {
    const id = this.pending.get(item.getSavePath()) ?? this.pendingRestart.get(item.getURL());
    if (!id) return false;
    this.pending.delete(item.getSavePath());
    const restart = this.pendingRestart.delete(item.getURL());
    const record = this.require(id);
    if (restart) item.setSavePath(record.path);
    this.bind(record, item);
    if (!restart) item.resume();
    record.state = "progressing";
    this.save();
    this.emit(id, this.legacy(record, "pending"));
    return true;
  }

  pause(id: string): void {
    this.requireActive(id).pause();
    this.updatePaused(id, true);
  }
  resume(id: string): void {
    this.requireActive(id).resume();
    this.updatePaused(id, false);
  }
  cancel(id: string): void {
    const item = this.requireActive(id);
    this.cancelling.add(id);
    item.cancel();
  }

  /** Keep an interrupted partial file when Electron cancels downloads during quit. */
  prepareForQuit(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const [id, item] of this.active) {
      if (this.cancelling.has(id)) continue;
      const record = this.require(id);
      try {
        item.pause();
        record.urlChain = item.getURLChain();
        record.eTag = item.getETag();
        record.lastModified = item.getLastModifiedTime();
        record.totalBytes = item.getTotalBytes() || null;
        const source = record.partialPath ?? record.path;
        const stat = FS.lstatSync(source);
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0) {
          const partial = record.partialPath ?? `${record.path}.penkra-partial-${record.id}`;
          if (source !== partial) {
            FS.linkSync(source, partial);
            FS.unlinkSync(source);
          }
          record.partialPath = partial;
          record.receivedBytes = stat.size;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          console.error("[app-browser-download] Could not preserve a partial download.", error);
      }
      record.state = "failed";
      record.secondsLeft = null;
    }
    this.saveFromEvent();
  }

  retry(id: string): void {
    const record = this.require(id);
    if (record.state !== "failed" && record.state !== "cancelled")
      throw new Error("Download is not finished.");
    const starting = new Set([...this.pending.values(), ...this.pendingRestart.values()]);
    if (starting.has(id)) throw new Error("Download retry is already starting.");
    const existing = this.records.find(
      (entry) =>
        entry.id !== id &&
        entry.url === record.url &&
        (this.active.has(entry.id) || starting.has(entry.id)),
    );
    if (existing) {
      this.emit(existing.id);
      return;
    }
    const partialPath = record.partialPath ?? record.path;
    let partialMatches = false;
    try {
      const stat = FS.lstatSync(partialPath);
      partialMatches =
        stat.isFile() && !stat.isSymbolicLink() && stat.size === record.receivedBytes;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      !record.totalBytes ||
      !record.receivedBytes ||
      !record.eTag ||
      !record.lastModified ||
      !partialMatches
    ) {
      const destination = prepareAppBrowserDownload(
        this.storage,
        this.owner,
        record.suggestedName,
        this.reservedPaths(),
      );
      record.path = destination.path;
      record.storagePath = destination.storagePath;
      record.fileName = Path.basename(destination.path);
      record.receivedBytes = 0;
      record.totalBytes = null;
      delete record.partialPath;
      this.pendingRestart.set(record.url, id);
      try {
        this.session.downloadURL(record.url);
      } catch (error) {
        this.pendingRestart.delete(record.url);
        throw error;
      }
      return;
    }
    this.pending.set(partialPath, id);
    try {
      this.session.createInterruptedDownload({
        path: partialPath,
        urlChain: record.urlChain,
        mimeType: record.mimeType,
        offset: record.receivedBytes,
        length: record.totalBytes,
        eTag: record.eTag,
        lastModified: record.lastModified,
        startTime: Date.parse(record.startedAt) / 1000,
      });
    } catch (error) {
      this.pending.delete(partialPath);
      throw error;
    }
  }

  clearFinished(): void {
    const starting = new Set([...this.pending.values(), ...this.pendingRestart.values()]);
    this.records = this.records.filter(
      (record) =>
        record.state === "progressing" || record.state === "paused" || starting.has(record.id),
    );
    this.save();
    this.emit();
  }

  pathForCompleted(id: string): string {
    const record = this.require(id);
    if (record.state !== "completed") throw new Error("Download is not complete.");
    return record.path;
  }

  private bind(record: Saved, item: DownloadItem): void {
    this.active.set(record.id, item);
    item.on("updated", (_event, state) => {
      if (this.shuttingDown) return;
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes() || null;
      const speed = item.getCurrentBytesPerSecond();
      record.secondsLeft =
        speed > 0 && record.totalBytes !== null
          ? Math.max(0, (record.totalBytes - record.receivedBytes) / speed)
          : null;
      record.state = item.isPaused() || state === "interrupted" ? "paused" : "progressing";
      record.urlChain = item.getURLChain();
      record.eTag = item.getETag();
      record.lastModified = item.getLastModifiedTime();
      this.saveFromEvent();
      this.emit();
    });
    item.once("done", (_event, state) => {
      this.active.delete(record.id);
      if (this.shuttingDown && !this.cancelling.delete(record.id)) return;
      this.cancelling.delete(record.id);
      record.receivedBytes = item.getReceivedBytes();
      record.totalBytes = item.getTotalBytes() || null;
      record.secondsLeft = null;
      record.state =
        state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed";
      if (state === "completed" && record.partialPath) {
        try {
          if (FS.existsSync(record.path)) {
            const destination = prepareAppBrowserDownload(
              this.storage,
              this.owner,
              record.suggestedName,
              this.reservedPaths(),
            );
            record.path = destination.path;
            record.storagePath = destination.storagePath;
            record.fileName = Path.basename(destination.path);
          }
          FS.linkSync(record.partialPath, record.path);
          FS.unlinkSync(record.partialPath);
          delete record.partialPath;
        } catch (error) {
          record.state = "failed";
          console.error("[app-browser-download] Could not finish the resumed download.", error);
        }
      }
      this.saveFromEvent();
      this.emit(
        undefined,
        this.legacy(record, record.state === "completed" ? "completed" : "failed"),
      );
    });
  }

  private updatePaused(id: string, paused: boolean): void {
    const record = this.require(id);
    record.state = paused ? "paused" : "progressing";
    record.secondsLeft = null;
    this.save();
    this.emit();
  }

  private require(id: string): Saved {
    const record = this.records.find((entry) => entry.id === id);
    if (!record) throw new Error("Download was not found in this App session.");
    return record;
  }

  private reservedPaths(): ReadonlySet<string> {
    return new Set(this.records.map((record) => record.path));
  }
  private requireActive(id: string): DownloadItem {
    this.require(id);
    const item = this.active.get(id);
    if (!item) throw new Error("Download is no longer active.");
    return item;
  }
  private legacy(record: Saved, state: AppBrowserDownloadEvent["state"]): AppBrowserDownloadEvent {
    return {
      pageId: record.pageId,
      url: record.url,
      suggestedName: record.suggestedName,
      mimeType: record.mimeType,
      path: record.path,
      storagePath: record.storagePath,
      state,
      bytes: record.receivedBytes,
      ...(state === "failed" ? { error: "Download failed." } : {}),
    };
  }
  private emit(revealId?: string, legacy?: AppBrowserDownloadEvent): void {
    this.publish({ downloads: this.list(), ...(revealId ? { revealId } : {}) }, legacy);
  }
  private save(): void {
    FS.mkdirSync(Path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    FS.writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600 });
    FS.renameSync(temp, this.file);
  }

  private saveFromEvent(): void {
    try {
      this.save();
    } catch (error) {
      console.error("[app-browser-download] Could not persist download state.", error);
    }
  }
}
