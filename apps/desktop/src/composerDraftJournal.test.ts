import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ComposerDraftJournal } from "./composerDraftJournal";

const roots: string[] = [];

async function makeJournal(): Promise<{ journal: ComposerDraftJournal; root: string }> {
  const root = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-composer-journal-"));
  roots.push(root);
  return { journal: new ComposerDraftJournal(root), root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => FS.promises.rm(root, { recursive: true })));
});

describe("ComposerDraftJournal", () => {
  it("serializes concurrent snapshot writes without losing the newer draft", async () => {
    const { journal } = await makeJournal();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_757_260_000_000);

    let releaseFirstWrite!: () => void;
    const firstWriteHeld = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let firstWriteEntered!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      firstWriteEntered = resolve;
    });
    const originalOpen = FS.promises.open.bind(FS.promises);
    const open = vi.spyOn(FS.promises, "open");
    let temporaryOpenCount = 0;
    open.mockImplementation(async (...args) => {
      const handle = await originalOpen(
        String(args[0]),
        args[1] as string,
        args[2] as number | undefined,
      );
      if (args[1] === "wx" && temporaryOpenCount++ === 0) {
        const originalWriteFile = handle.writeFile.bind(handle);
        handle.writeFile = (async (data: string | Uint8Array) => {
          firstWriteEntered();
          await firstWriteHeld;
          return originalWriteFile(data);
        }) as typeof handle.writeFile;
      }
      return handle;
    });

    try {
      const older = journal.writeSnapshot("older");
      await firstWriteStarted;
      const newer = journal.writeSnapshot("newer");
      await new Promise<void>((resolve) => setImmediate(resolve));
      releaseFirstWrite();

      const results = await Promise.allSettled([older, newer]);
      expect(results).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(await journal.readSnapshot()).toBe("newer");
    } finally {
      open.mockRestore();
      now.mockRestore();
    }
  });

  it("atomically survives a snapshot restart", async () => {
    const { journal, root } = await makeJournal();
    await journal.writeSnapshot('{"state":{"prompt":"hello"}}');

    const restarted = new ComposerDraftJournal(root);
    expect(await restarted.readSnapshot()).toBe('{"state":{"prompt":"hello"}}');
  });

  it("stores binary attachments separately from the draft snapshot", async () => {
    const { journal, root } = await makeJournal();
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    const descriptor = await journal.writeAsset({
      id: "attachment-1",
      draftId: "thread-1",
      name: "sample.bin",
      mimeType: "application/octet-stream",
      bytes,
    });

    expect(descriptor.committedBytes).toBe(bytes.byteLength);
    expect(
      Array.from((await new ComposerDraftJournal(root).readAsset("attachment-1")) ?? []),
    ).toEqual(Array.from(bytes));
  });

  it("recovers only acknowledged voice batches after interruption", async () => {
    const { journal, root } = await makeJournal();
    const now = new Date().toISOString();
    await journal.createVoice({
      id: "voice-1",
      threadId: "thread-1",
      cwd: "/workspace",
      sampleRateHz: 48_000,
      state: "recording",
      committedBytes: 0,
      lastSequence: -1,
      createdAt: now,
      updatedAt: now,
    });
    await journal.appendVoice({ id: "voice-1", sequence: 0, bytes: new Uint8Array([1, 2, 3, 4]) });
    await journal.appendVoice({ id: "voice-1", sequence: 1, bytes: new Uint8Array([5, 6, 7, 8]) });
    // Simulate a process dying after bytes reached the audio file but before the
    // atomic committed-boundary index advanced.
    await FS.promises.appendFile(
      Path.join(root, "composer-drafts-v1", "voice", "voice-1.f32le"),
      new Uint8Array([9, 10, 11, 12]),
    );

    const restarted = new ComposerDraftJournal(root);
    expect(await restarted.listVoices()).toMatchObject([
      { id: "voice-1", state: "recording", committedBytes: 8, lastSequence: 1 },
    ]);
    expect(Array.from((await restarted.readVoice("voice-1")) ?? [])).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it("rejects a skipped voice sequence without advancing the committed boundary", async () => {
    const { journal } = await makeJournal();
    const now = new Date().toISOString();
    await journal.createVoice({
      id: "voice-2",
      threadId: "thread-1",
      cwd: "/workspace",
      sampleRateHz: 48_000,
      state: "recording",
      committedBytes: 0,
      lastSequence: -1,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      journal.appendVoice({ id: "voice-2", sequence: 1, bytes: new Uint8Array([1, 2, 3, 4]) }),
    ).rejects.toThrow("out of order");
    expect(await journal.listVoices()).toMatchObject([
      { id: "voice-2", committedBytes: 0, lastSequence: -1 },
    ]);
  });
});
