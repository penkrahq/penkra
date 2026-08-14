// FILE: voiceTranscriptionJobStore.ts
// Purpose: Reconciles and durably stores ready voice recordings until one transcription attempt.
// Layer: Browser storage adapter

import { type ThreadId } from "@penkra/contracts";

import { awaitIdbRequest, openIndexedDbDatabase, waitForIdbTransaction } from "./indexedDb";
import {
  captureVoiceRecordingFromFloat32Bytes,
  type CapturedVoiceRecordingPayload,
} from "./voiceRecordingChunks";

const DATABASE_NAME = "penkra-voice-transcriptions";
const DATABASE_VERSION = 1;
const STORE_NAME = "jobs";

export interface VoiceTranscriptionJob {
  readonly id: string;
  readonly threadId: ThreadId;
  readonly providerThreadId?: ThreadId | undefined;
  readonly cwd: string;
  readonly recording: CapturedVoiceRecordingPayload;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function openVoiceTranscriptionDatabase(): Promise<IDBDatabase> {
  return openIndexedDbDatabase({
    name: DATABASE_NAME,
    version: DATABASE_VERSION,
    storeName: STORE_NAME,
    keyPath: "id",
    label: "voice transcription database",
  });
}

export async function persistVoiceTranscriptionJob(job: VoiceTranscriptionJob): Promise<void> {
  if (job.recording.durableVoiceDraftId && window.desktopBridge?.composerDrafts) {
    return;
  }
  const database = await openVoiceTranscriptionDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(job);
    await waitForIdbTransaction(transaction, "Voice transcription storage");
  } finally {
    database.close();
  }
}

export async function listVoiceTranscriptionJobs(): Promise<VoiceTranscriptionJob[]> {
  const desktopJobs = await listDesktopVoiceTranscriptionJobs();
  if (typeof indexedDB === "undefined") return desktopJobs;
  const database = await openVoiceTranscriptionDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const completion = waitForIdbTransaction(transaction, "Voice transcription storage");
    const storedJobs = (await awaitIdbRequest(
      transaction.objectStore(STORE_NAME).getAll(),
      "Could not read saved voice recordings.",
    )) as unknown[];
    await completion;
    const jobs = storedJobs.flatMap(normalizeStoredVoiceTranscriptionJob);
    return [...jobs, ...desktopJobs].toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
  } finally {
    database.close();
  }
}

function normalizeStoredVoiceTranscriptionJob(value: unknown): VoiceTranscriptionJob[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const job = { ...record };
  delete job.transcriptionBackend;
  delete job.connectionId;
  return [job as unknown as VoiceTranscriptionJob];
}

export async function deleteVoiceTranscriptionJob(jobId: string): Promise<void> {
  if (!jobId) return;
  await window.desktopBridge?.composerDrafts?.deleteVoice(jobId).catch((error: unknown) => {
    console.warn("[voice-recorder] Could not delete the desktop voice draft.", error);
  });
  if (typeof indexedDB === "undefined") return;
  const database = await openVoiceTranscriptionDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(jobId);
    await waitForIdbTransaction(transaction, "Voice transcription storage");
  } finally {
    database.close();
  }
}

async function listDesktopVoiceTranscriptionJobs(): Promise<VoiceTranscriptionJob[]> {
  const bridge = window.desktopBridge?.composerDrafts;
  if (!bridge) return [];
  const descriptors = await bridge.listVoices();
  const jobs = await Promise.all(
    descriptors.map(async (descriptor): Promise<VoiceTranscriptionJob | null> => {
      if (descriptor.state === "recording") {
        if (descriptor.committedBytes === 0) {
          await bridge.deleteVoice(descriptor.id);
          return null;
        }
        await bridge.completeVoice(descriptor.id);
      }
      const bytes = await bridge.readVoice(descriptor.id);
      if (!bytes) {
        await bridge.deleteVoice(descriptor.id);
        return null;
      }
      const recording = captureVoiceRecordingFromFloat32Bytes({
        bytes,
        sampleRateHz: descriptor.sampleRateHz,
        durableVoiceDraftId: descriptor.id,
      });
      if (!recording) {
        await bridge.deleteVoice(descriptor.id);
        return null;
      }
      return {
        id: descriptor.id,
        threadId: descriptor.threadId as ThreadId,
        ...(descriptor.providerThreadId
          ? { providerThreadId: descriptor.providerThreadId as ThreadId }
          : {}),
        cwd: descriptor.cwd,
        recording,
        createdAt: descriptor.createdAt,
        updatedAt: descriptor.updatedAt,
      };
    }),
  );
  return jobs.filter((job): job is VoiceTranscriptionJob => job !== null);
}
