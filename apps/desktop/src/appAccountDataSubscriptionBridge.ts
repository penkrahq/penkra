import type { AppAccountRealtimeConnectionState, AppAccountRealtimeEvent } from "@penkra/sdk";

type SubscriptionMessage = {
  subscriptionId?: string;
  event?: AppAccountRealtimeEvent;
  connectionState?: AppAccountRealtimeConnectionState;
};

export async function subscribeAccountDataWithBufferedHandshake(input: {
  start(): Promise<string>;
  listen(listener: (message: SubscriptionMessage) => void): () => void;
  stop(subscriptionId: string): void;
  onEvent(event: AppAccountRealtimeEvent): void;
  onConnectionStateChange?(state: AppAccountRealtimeConnectionState): void;
}): Promise<() => void> {
  let subscriptionId: string | null = null;
  let active = true;
  let receivedConnectionState = false;
  const pending: SubscriptionMessage[] = [];
  const deliver = (message: SubscriptionMessage) => {
    if (!active) return;
    if (subscriptionId === null) {
      pending.push(message);
      return;
    }
    if (message.subscriptionId !== subscriptionId) return;
    if (message.event) input.onEvent(message.event);
    if (message.connectionState) {
      receivedConnectionState = true;
      input.onConnectionStateChange?.(message.connectionState);
    }
  };
  const unlisten = input.listen(deliver);
  try {
    subscriptionId = await input.start();
    for (const message of pending) deliver(message);
    pending.length = 0;
    // A successful start means the host connected and authorized the channel.
    // Preserve that guarantee even if the initial IPC state notification raced
    // the invoke response and was not observable in this renderer.
    if (!receivedConnectionState) input.onConnectionStateChange?.("connected");
  } catch (error) {
    active = false;
    unlisten();
    throw error;
  }
  return () => {
    if (!active || subscriptionId === null) return;
    active = false;
    unlisten();
    input.stop(subscriptionId);
  };
}
