// FILE: composerDraftJournal.ts
// Purpose: Owns crash-durable composer snapshots, binary assets, and live voice journals.
// Layer: Electron main-process storage

import * as FS from "node:fs";
import * as Path from "node:path";

import type {
  DesktopComposerAssetDescriptor,
  DesktopVoiceDraftDescriptor,
} from "@penkra/contracts";
import { resolveDesktopPlatformAdapter } from "./desktopPlatform";

const ROOT_DIRECTORY_NAME = "composer-drafts-v1";
const SNAPSHOT_FILE_NAME = "snapshot.json";
const VOICE_INDEX_FILE_NAME = "voice-index.json";
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_ASSET_BYTES = 256 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

interface VoiceIndexFile {
  version: 1;
  jobs: DesktopVoiceDraftDescriptor[];
}

function assertSafeId(value: string, label: string): void {
  if (!SAFE_ID.test(value)) throw new Error(`Invalid ${label}.`);
}

async function syncDirectory(path: string): Promise<void> {
  if (!resolveDesktopPlatformAdapter().processLifecycle.syncDirectories) return;
  const handle = await FS.promises.open(path, "r").catch(() => null);
  if (!handle) return;
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFileAtomically(path: string, contents: Uint8Array | string): Promise<void> {
  const directory = Path.dirname(path);
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await FS.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  let handle: FS.promises.FileHandle | null = null;
  try {
    handle = await FS.promises.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await FS.promises.rename(temporaryPath, path);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await FS.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function parseVoiceIndex(value: unknown): VoiceIndexFile {
  if (!value || typeof value !== "object") return { version: 1, jobs: [] };
  const candidate = value as Partial<VoiceIndexFile>;
  if (candidate.version !== 1 || !Array.isArray(candidate.jobs)) return { version: 1, jobs: [] };
  return {
    version: 1,
    jobs: candidate.jobs.flatMap((job): DesktopVoiceDraftDescriptor[] => {
      if (!job || typeof job !== "object") return [];
      const record = job as unknown as Record<string, unknown>;
      const valid =
        typeof job.id === "string" &&
        SAFE_ID.test(job.id) &&
        typeof job.threadId === "string" &&
        typeof job.cwd === "string" &&
        typeof job.sampleRateHz === "number" &&
        Number.isFinite(job.sampleRateHz) &&
        job.sampleRateHz > 0 &&
        typeof job.committedBytes === "number" &&
        Number.isSafeInteger(job.committedBytes) &&
        job.committedBytes >= 0 &&
        typeof job.lastSequence === "number" &&
        Number.isSafeInteger(job.lastSequence) &&
        (job.state === "recording" || job.state === "ready");
      if (!valid) return [];
      const draft = { ...record };
      delete draft.transcriptionBackend;
      delete draft.connectionId;
      return [draft as unknown as DesktopVoiceDraftDescriptor];
    }),
  };
}

export class ComposerDraftJournal {
  readonly #rootPath: string;
  readonly #assetsPath: string;
  readonly #voicesPath: string;
  readonly #snapshotPath: string;
  readonly #voiceIndexPath: string;
  #voiceMutation = Promise.resolve();

  constructor(userDataPath: string) {
    this.#rootPath = Path.join(userDataPath, ROOT_DIRECTORY_NAME);
    this.#assetsPath = Path.join(this.#rootPath, "assets");
    this.#voicesPath = Path.join(this.#rootPath, "voice");
    this.#snapshotPath = Path.join(this.#rootPath, SNAPSHOT_FILE_NAME);
    this.#voiceIndexPath = Path.join(this.#rootPath, VOICE_INDEX_FILE_NAME);
  }

  async readSnapshot(): Promise<string | null> {
    try {
      const stats = await FS.promises.stat(this.#snapshotPath);
      if (!stats.isFile() || stats.size > MAX_SNAPSHOT_BYTES) return null;
      return await FS.promises.readFile(this.#snapshotPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async writeSnapshot(value: string): Promise<void> {
    if (Buffer.byteLength(value, "utf8") > MAX_SNAPSHOT_BYTES) {
      throw new Error("Composer draft snapshot is too large.");
    }
    await writeFileAtomically(this.#snapshotPath, value);
  }

  async removeSnapshot(): Promise<void> {
    await FS.promises.rm(this.#snapshotPath, { force: true });
    await syncDirectory(this.#rootPath);
  }

  async writeAsset(input: {
    id: string;
    draftId: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<DesktopComposerAssetDescriptor> {
    assertSafeId(input.id, "composer asset id");
    if (input.bytes.byteLength > MAX_ASSET_BYTES) throw new Error("Composer asset is too large.");
    const path = Path.join(this.#assetsPath, `${input.id}.bin`);
    await writeFileAtomically(path, input.bytes);
    return {
      id: input.id,
      draftId: input.draftId,
      name: input.name,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.byteLength,
      committedBytes: input.bytes.byteLength,
    };
  }

  async readAsset(id: string): Promise<Uint8Array | null> {
    assertSafeId(id, "composer asset id");
    try {
      const bytes = await FS.promises.readFile(Path.join(this.#assetsPath, `${id}.bin`));
      if (bytes.byteLength > MAX_ASSET_BYTES) return null;
      return new Uint8Array(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async deleteAsset(id: string): Promise<void> {
    assertSafeId(id, "composer asset id");
    await FS.promises.rm(Path.join(this.#assetsPath, `${id}.bin`), { force: true });
  }

  async createVoice(job: DesktopVoiceDraftDescriptor): Promise<void> {
    assertSafeId(job.id, "voice draft id");
    await this.#mutateVoices(async (index) => {
      if (index.jobs.some((candidate) => candidate.id === job.id)) {
        throw new Error("Voice draft already exists.");
      }
      await writeFileAtomically(this.#voicePath(job.id), new Uint8Array());
      index.jobs.push({ ...job, state: "recording", committedBytes: 0, lastSequence: -1 });
    });
  }

  async appendVoice(input: {
    id: string;
    sequence: number;
    bytes: Uint8Array;
  }): Promise<DesktopVoiceDraftDescriptor> {
    assertSafeId(input.id, "voice draft id");
    if (input.bytes.byteLength === 0 || input.bytes.byteLength > 4 * 1024 * 1024) {
      throw new Error("Invalid voice draft batch.");
    }
    let committed: DesktopVoiceDraftDescriptor | null = null;
    await this.#mutateVoices(async (index) => {
      const jobIndex = index.jobs.findIndex((candidate) => candidate.id === input.id);
      const job = index.jobs[jobIndex];
      if (!job || job.state !== "recording") throw new Error("Voice draft is not recording.");
      if (input.sequence <= job.lastSequence) {
        committed = job;
        return;
      }
      if (input.sequence !== job.lastSequence + 1)
        throw new Error("Voice draft batch is out of order.");
      if (job.committedBytes + input.bytes.byteLength > MAX_ASSET_BYTES) {
        throw new Error("Voice draft is too large.");
      }
      await FS.promises.mkdir(this.#voicesPath, { recursive: true, mode: 0o700 });
      const handle = await FS.promises.open(this.#voicePath(input.id), "a", 0o600);
      try {
        await handle.write(input.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      committed = {
        ...job,
        committedBytes: job.committedBytes + input.bytes.byteLength,
        lastSequence: input.sequence,
        updatedAt: new Date().toISOString(),
      };
      index.jobs[jobIndex] = committed;
    });
    if (!committed) throw new Error("Voice draft append did not commit.");
    return committed;
  }

  async completeVoice(id: string): Promise<DesktopVoiceDraftDescriptor> {
    assertSafeId(id, "voice draft id");
    let completed: DesktopVoiceDraftDescriptor | null = null;
    await this.#mutateVoices((index) => {
      const jobIndex = index.jobs.findIndex((candidate) => candidate.id === id);
      const job = index.jobs[jobIndex];
      if (!job) throw new Error("Voice draft was not found.");
      completed = { ...job, state: "ready", updatedAt: new Date().toISOString() };
      index.jobs[jobIndex] = completed;
    });
    if (!completed) throw new Error("Voice draft completion did not commit.");
    return completed;
  }

  async listVoices(): Promise<DesktopVoiceDraftDescriptor[]> {
    await this.#voiceMutation;
    return (await this.#readVoiceIndex()).jobs.toSorted((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  async readVoice(id: string): Promise<Uint8Array | null> {
    assertSafeId(id, "voice draft id");
    const job = (await this.#readVoiceIndex()).jobs.find((candidate) => candidate.id === id);
    if (!job) return null;
    try {
      const handle = await FS.promises.open(this.#voicePath(id), "r");
      try {
        const bytes = new Uint8Array(job.committedBytes);
        const result = await handle.read(bytes, 0, job.committedBytes, 0);
        return result.bytesRead === job.committedBytes ? bytes : bytes.slice(0, result.bytesRead);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async deleteVoice(id: string): Promise<void> {
    assertSafeId(id, "voice draft id");
    await this.#mutateVoices(async (index) => {
      index.jobs = index.jobs.filter((candidate) => candidate.id !== id);
      await FS.promises.rm(this.#voicePath(id), { force: true });
    });
  }

  #voicePath(id: string): string {
    return Path.join(this.#voicesPath, `${id}.f32le`);
  }

  async #readVoiceIndex(): Promise<VoiceIndexFile> {
    try {
      return parseVoiceIndex(JSON.parse(await FS.promises.readFile(this.#voiceIndexPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, jobs: [] };
      if (error instanceof SyntaxError) return { version: 1, jobs: [] };
      throw error;
    }
  }

  #mutateVoices(operation: (index: VoiceIndexFile) => void | Promise<void>): Promise<void> {
    const mutation = this.#voiceMutation.then(async () => {
      const index = await this.#readVoiceIndex();
      await operation(index);
      await writeFileAtomically(this.#voiceIndexPath, `${JSON.stringify(index)}\n`);
    });
    this.#voiceMutation = mutation.catch(() => undefined);
    return mutation;
  }
}
