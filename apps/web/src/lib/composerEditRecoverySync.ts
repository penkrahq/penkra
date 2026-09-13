// FILE: composerEditRecoverySync.ts
// Purpose: Mirrors queued-message edit recovery across windows without syncing unrelated drafts.

import type { DesktopComposerEditRecovery, ThreadId } from "@penkra/contracts";

import type { QueuedComposerTurn } from "../composerDraftDomain";
import {
  hydrateQueuedComposerTurnFromWindowSync,
  serializeQueuedComposerTurnForWindowSync,
} from "../composerDraftPersistence";

export interface ComposerEditRecoveryTransport {
  publish(recovery: DesktopComposerEditRecovery): void;
  subscribe(listener: (recovery: DesktopComposerEditRecovery) => void): () => void;
}

interface ComposerEditRecoverySyncOptions {
  transport: ComposerEditRecoveryTransport;
  recover(threadId: ThreadId, queuedTurn: QueuedComposerTurn): boolean;
  createRecoveryId?: () => string;
}

export function createComposerEditRecoverySync(options: ComposerEditRecoverySyncOptions): {
  publish(threadId: ThreadId, queuedTurn: QueuedComposerTurn): boolean;
  dispose(): void;
} {
  const seenRecoveryIds = new Set<string>();
  const dispose = options.transport.subscribe((recovery) => {
    if (
      !recovery ||
      typeof recovery.recoveryId !== "string" ||
      recovery.recoveryId.length === 0 ||
      typeof recovery.threadId !== "string" ||
      recovery.threadId.length === 0 ||
      typeof recovery.queuedTurnId !== "string" ||
      typeof recovery.queuedTurnJson !== "string" ||
      seenRecoveryIds.has(recovery.recoveryId)
    ) {
      return;
    }
    const queuedTurn = hydrateQueuedComposerTurnFromWindowSync(
      recovery.threadId,
      recovery.queuedTurnJson,
    );
    if (!queuedTurn || queuedTurn.id !== recovery.queuedTurnId) return;
    seenRecoveryIds.add(recovery.recoveryId);
    if (seenRecoveryIds.size > 256) {
      const oldest = seenRecoveryIds.values().next().value;
      if (oldest !== undefined) seenRecoveryIds.delete(oldest);
    }
    options.recover(recovery.threadId, queuedTurn);
    console.info("[composer-edit-recovery] Applied remote recovery.", {
      recoveryId: recovery.recoveryId,
      threadId: recovery.threadId,
      queuedTurnId: recovery.queuedTurnId,
      monotonicMs: performance.now(),
    });
  });

  return {
    publish: (threadId, queuedTurn) => {
      let queuedTurnJson: string;
      try {
        queuedTurnJson = serializeQueuedComposerTurnForWindowSync(queuedTurn);
      } catch (error) {
        console.error("[composer-edit-recovery] Could not serialize recovery.", {
          threadId,
          queuedTurnId: queuedTurn.id,
          error,
        });
        return false;
      }
      const recovery: DesktopComposerEditRecovery = {
        recoveryId: options.createRecoveryId?.() ?? crypto.randomUUID(),
        threadId,
        queuedTurnId: queuedTurn.id,
        queuedTurnJson,
      };
      options.transport.publish(recovery);
      console.info("[composer-edit-recovery] Published recovery.", {
        recoveryId: recovery.recoveryId,
        threadId,
        queuedTurnId: queuedTurn.id,
        monotonicMs: performance.now(),
      });
      return true;
    },
    dispose,
  };
}
