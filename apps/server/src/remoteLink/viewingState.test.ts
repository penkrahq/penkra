import { expect, it } from "vitest";
import { RemoteViewingState } from "./viewingState";

it("tracks each session independently and clears only the closed session", () => {
  const state = new RemoteViewingState();
  state.set("phone", "session-a", "thread-a");
  state.set("phone", "session-b", "thread-a");
  state.set("other-phone", "session-c", "thread-b");
  state.set("phone", "session-a", null);
  expect(state.viewing("phone", "thread-a")).toBe(true);
  expect(state.viewing("phone", "thread-b")).toBe(false);
  state.set("phone", "session-b", null);
  expect(state.viewing("phone", "thread-a")).toBe(false);
  expect(state.viewing("other-phone", "thread-b")).toBe(true);
  state.clear();
  expect(state.viewing("other-phone", "thread-b")).toBe(false);
});
