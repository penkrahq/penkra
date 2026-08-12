import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { ProviderConnectionId } from "@penkra/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { ComposerDraftJournal } from "./composerDraftJournal";

const roots: string[] = [];
const CODEX_CONNECTION_ID = ProviderConnectionId.makeUnsafe("connection-codex");

async function makeJournal(): Promise<{ journal: ComposerDraftJournal; root: string }> {
  const root = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-composer-journal-"));
  roots.push(root);
  return { journal: new ComposerDraftJournal(root), root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => FS.promises.rm(root, { recursive: true })));
});

describe("ComposerDraftJournal", () => {
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
      transcriptionBackend: { kind: "codex-chatgpt", connectionId: CODEX_CONNECTION_ID },
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
      transcriptionBackend: { kind: "codex-chatgpt", connectionId: CODEX_CONNECTION_ID },
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
