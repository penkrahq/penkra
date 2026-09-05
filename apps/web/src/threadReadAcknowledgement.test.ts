// FILE: threadReadAcknowledgement.test.ts
// Purpose: Verifies the manual-unread lifetime across active and inactive Threads.

import { afterEach, describe, expect, it } from "vitest";

import {
  deferThreadReadAcknowledgementIfActive,
  isThreadReadAcknowledgementDeferred,
  releaseThreadReadAcknowledgement,
} from "./threadReadAcknowledgement";

const THREAD_ID = "thread-1";

afterEach(() => releaseThreadReadAcknowledgement(THREAD_ID));

describe("manual unread acknowledgement deferral", () => {
  it("holds unread state only when the marked Thread is already active", () => {
    expect(deferThreadReadAcknowledgementIfActive(THREAD_ID, THREAD_ID)).toBe(true);
    expect(isThreadReadAcknowledgementDeferred(THREAD_ID)).toBe(true);
  });

  it("does not defer the first visit to an inactive Thread", () => {
    expect(deferThreadReadAcknowledgementIfActive(THREAD_ID, "thread-2")).toBe(false);
    expect(isThreadReadAcknowledgementDeferred(THREAD_ID)).toBe(false);
  });

  it("allows acknowledgement again after leaving the Thread", () => {
    deferThreadReadAcknowledgementIfActive(THREAD_ID, THREAD_ID);
    releaseThreadReadAcknowledgement(THREAD_ID);
    expect(isThreadReadAcknowledgementDeferred(THREAD_ID)).toBe(false);
  });
});
