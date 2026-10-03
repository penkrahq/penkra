import { randomUUID } from "node:crypto";

export interface AppTabActivationRequest {
  requestId: string;
  tabId: string;
  windowId: number;
}

/** A selection request completes on native presentation, never on an elapsed delay. */
export class AppTabActivation {
  readonly #pending = new Map<
    string,
    {
      request: AppTabActivationRequest;
      claimed: boolean;
      resolve: () => void;
      reject: (error: Error) => void;
      dispose: () => void;
    }
  >();

  request(
    tabId: string,
    windowId: number,
    signal: AbortSignal,
    publish: (request: AppTabActivationRequest) => void,
  ): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    this.cancelWindow(windowId, "Another activation superseded this request.");
    return new Promise((resolve, reject) => {
      const request = { requestId: randomUUID(), tabId, windowId };
      const abort = () => this.#finish(request.requestId, signal.reason);
      this.#pending.set(request.requestId, {
        request,
        claimed: false,
        resolve,
        reject,
        dispose: () => signal.removeEventListener("abort", abort),
      });
      signal.addEventListener("abort", abort, { once: true });
      try {
        publish(request);
      } catch (error) {
        this.#finish(request.requestId, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  claim(requestId: string, windowId: number): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending || pending.claimed || pending.request.windowId !== windowId) return false;
    pending.claimed = true;
    return true;
  }

  presented(tabId: string, windowId: number): void {
    for (const [id, pending] of this.#pending) {
      if (
        pending.claimed &&
        pending.request.tabId === tabId &&
        pending.request.windowId === windowId
      ) {
        this.#finish(id);
      }
    }
  }

  cancelTab(tabId: string): void {
    for (const [id, pending] of this.#pending) {
      if (pending.request.tabId === tabId)
        this.#finish(id, new Error("The tab closed during activation."));
    }
  }

  cancelWindow(windowId: number, message = "The window closed during activation."): void {
    for (const [id, pending] of this.#pending) {
      if (pending.request.windowId === windowId) this.#finish(id, new Error(message));
    }
  }

  #finish(id: string, error?: Error): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    pending.dispose();
    if (error) pending.reject(Object.assign(error, { code: "TAB_ACTIVATION_CANCELLED" }));
    else pending.resolve();
  }
}
