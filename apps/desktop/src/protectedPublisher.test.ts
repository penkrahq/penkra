import { describe, expect, it, vi } from "vitest";

import { ProtectedPublisher } from "./protectedPublisher";

describe("ProtectedPublisher", () => {
  it("isolates every observer and its terminal failure sink", async () => {
    const terminal = vi.fn(() => {
      throw new Error("terminal sink failed");
    });
    const publisher = new ProtectedPublisher<number>(terminal);
    const later = vi.fn();
    publisher.subscribe(() => {
      throw new Error("sync observer failed");
    });
    publisher.subscribe(async () => {
      throw new Error("async observer failed");
    });
    publisher.subscribe(later);

    expect(() => publisher.publish(7)).not.toThrow();
    await Promise.resolve();
    expect(later).toHaveBeenCalledWith(7);
    expect(terminal).toHaveBeenCalledTimes(2);
  });

  it("swallows a rejected terminal sink without producing a second notification path", async () => {
    const publisher = new ProtectedPublisher(() => Promise.reject(new Error("sink rejected")));
    publisher.subscribe(() => {
      throw new Error("observer failed");
    });

    expect(() => publisher.publish(undefined)).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });
});
