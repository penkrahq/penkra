import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FeedbackDialog } from "./FeedbackDialog";
import type { FeedbackThreadContext } from "../feedback";

const fixture = vi.hoisted(() => ({
  request: { current: null as AbortController | null },
  cleanup: undefined as undefined | (() => void),
  submit: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("react", async () => ({
  ...(await vi.importActual("react")),
  useRef: () => fixture.request,
  useState: () => [false, vi.fn()],
  useEffect: (effect: () => () => void) => {
    fixture.cleanup = effect();
  },
}));
vi.mock("../feedback", () => ({
  buildFeedbackSubmission: () => ({}),
  submitFeedback: fixture.submit,
  FEEDBACK_CATEGORIES: [],
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: fixture.toast } }));
const context: FeedbackThreadContext = {
  provider: null,
  model: null,
  projectKind: null,
  runtimeMode: null,
  sessionStatus: null,
  latestTurnState: null,
  messageCount: 0,
  activityCount: 0,
  hasPendingUserInput: false,
  hasThreadError: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  fixture.request.current = null;
  fixture.submit.mockImplementation(
    (_submission, signal: AbortSignal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Cancelled", "AbortError")),
          { once: true },
        );
      }),
  );
});
afterEach(() => fixture.cleanup?.());

function openDialog() {
  const onOpenChange = vi.fn();
  const dialog = FeedbackDialog({ open: true, context, onOpenChange });
  const popup = dialog.props.children as ReactElement<{
    showCloseButton: boolean;
    children: ReactElement[];
  }>;
  const form = popup.props.children[1] as ReactElement<{
    onSubmit: (category: null, details: string) => Promise<void>;
  }>;
  return { dialog, popup, form, onOpenChange };
}

it("keeps Close available and aborts sending when the user closes", async () => {
  const { dialog, popup, form, onOpenChange } = openDialog();
  const sending = form.props.onSubmit(null, "A report");
  const signal = fixture.submit.mock.calls[0]?.[1] as AbortSignal;
  expect(popup.props.showCloseButton).toBe(true);
  expect(signal.aborted).toBe(false);
  dialog.props.onOpenChange(false);
  await sending;
  expect(signal.aborted).toBe(true);
  expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  expect(fixture.toast).not.toHaveBeenCalled();
});

it("aborts sending on unmount without reporting cancellation as an error", async () => {
  const { form } = openDialog();
  const sending = form.props.onSubmit(null, "A report");
  const signal = fixture.submit.mock.calls[0]?.[1] as AbortSignal;
  fixture.cleanup?.();
  await sending;
  expect(signal.aborted).toBe(true);
  expect(fixture.toast).not.toHaveBeenCalled();
});
