// FILE: taskCompletion.tsx
// Purpose: Bridges thread completion and attention-needed events to in-app toasts and OS notifications.
// Layer: Notification runtime
// Exports: TaskCompletionNotifications and browser permission helpers

import { ThreadId } from "@penkra/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toastManager } from "../components/ui/toast";
import { resolveVisibleToastThreadIds } from "../components/ui/toastRouteVisibility";
import { useAppSettings } from "../appSettings";
import { isElectron } from "../env";
import { useStore } from "../store";
import type { Thread } from "../types";
import {
  getThreadList,
  subscribeThreadRowChanges,
  subscribeThreadPageReads,
} from "../threadListStore";
import {
  buildInputNeededCopy,
  buildTaskCompletionCopy,
  createCompletedThreadTracker,
  createOpenQuestionTracker,
  focusAvailableNotificationThread,
} from "./taskCompletion.logic";

export type BrowserNotificationPermissionState =
  | NotificationPermission
  | "unsupported"
  | "insecure";

function isBrowserNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

// Browsers require secure contexts and a user gesture before asking for permission.
export function readBrowserNotificationPermissionState(): BrowserNotificationPermissionState {
  if (typeof window === "undefined") {
    return "unsupported";
  }
  if (!isBrowserNotificationSupported()) {
    return "unsupported";
  }
  if (!window.isSecureContext) {
    return "insecure";
  }
  return Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<BrowserNotificationPermissionState> {
  const current = readBrowserNotificationPermissionState();
  if (current === "unsupported" || current === "insecure" || current === "denied") {
    return current;
  }
  if (current === "granted") {
    return current;
  }
  return Notification.requestPermission();
}

function isWindowForeground(): boolean {
  if (typeof document === "undefined") {
    return true;
  }
  return document.visibilityState === "visible" && document.hasFocus();
}

interface ThreadNotificationCopy {
  title: string;
  body: string;
}

function focusThread(threadId: Thread["id"], navigate: ReturnType<typeof useNavigate>): void {
  focusAvailableNotificationThread({
    threadId,
    state: useStore.getState(),
    navigate: (availableThreadId) => {
      void navigate({
        to: "/$threadId",
        params: { threadId: availableThreadId },
        search: () => ({}),
      });
    },
  });
}

async function showSystemThreadNotification(
  copy: ThreadNotificationCopy,
  threadId: Thread["id"],
  navigate: ReturnType<typeof useNavigate>,
): Promise<boolean> {
  const { body, title } = copy;

  if (window.desktopBridge) {
    const supported = await window.desktopBridge.notifications.isSupported();
    if (!supported) {
      return false;
    }
    return window.desktopBridge.notifications.show({ title, body, silent: false, threadId });
  }

  if (readBrowserNotificationPermissionState() !== "granted") {
    return false;
  }

  const notification = new Notification(title, {
    body,
    tag: `thread-notification:${threadId}`,
  });
  notification.addEventListener("click", () => {
    window.focus();
    focusThread(threadId, navigate);
  });
  return true;
}

function showThreadToast(
  copy: ThreadNotificationCopy,
  threadId: Thread["id"],
  tone: "success" | "warning",
  navigate: ReturnType<typeof useNavigate>,
): void {
  const { body, title } = copy;
  toastManager.add({
    type: tone,
    title,
    description: body,
    data: {
      allowCrossThreadVisibility: true,
      compactContextual: true,
      threadId,
      dismissAfterVisibleMs: 8000,
    },
    actionProps: {
      "aria-label": `Open ${title}`,
      children: "Open",
      onClick: () => focusThread(threadId, navigate),
    },
  });
}

export function TaskCompletionNotifications() {
  const { settings } = useAppSettings();
  const navigate = useNavigate();
  const activeThreadId = useParams({
    strict: false,
    select: (params) =>
      typeof params.threadId === "string" ? ThreadId.makeUnsafe(params.threadId) : null,
  });
  const threadsHydrated = useStore((store) => store.threadsHydrated);
  const visibleThreadIds = resolveVisibleToastThreadIds({ activeThreadId });

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      const prefix = "notification-open-thread:";
      if (!action.startsWith(prefix)) {
        return;
      }
      const threadId = action.slice(prefix.length).trim();
      if (threadId.length === 0) {
        return;
      }
      focusThread(threadId as Thread["id"], navigate);
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  const completionOptionsRef = useRef({ settings, visibleThreadIds, navigate });
  completionOptionsRef.current = { settings, visibleThreadIds, navigate };
  useEffect(() => {
    if (!threadsHydrated) return;
    const tracker = createCompletedThreadTracker(getThreadList());
    const questions = createOpenQuestionTracker(getThreadList());
    const stopBaseline = subscribeThreadPageReads((rows) => {
      tracker.observeBaseline(rows);
      questions.observeBaseline(rows);
    });
    const stopChanges = subscribeThreadRowChanges(
      (_change, row) => {
        if (row === null) return;
        const options = completionOptionsRef.current;
        const question = questions.consume(row, options.visibleThreadIds);
        if (question) {
          const copy = buildInputNeededCopy(question);
          if (options.settings.enableTaskCompletionToasts)
            showThreadToast(copy, question.threadId, "warning", options.navigate);
          if (
            options.settings.enableSystemTaskCompletionNotifications &&
            (window.desktopBridge || !isWindowForeground())
          )
            void showSystemThreadNotification(copy, question.threadId, options.navigate);
        }
        const completion = tracker.consume(row, options.visibleThreadIds);
        if (completion === null) return;
        const copy = buildTaskCompletionCopy(completion);
        if (options.settings.enableTaskCompletionToasts)
          showThreadToast(copy, completion.threadId, "success", options.navigate);
        if (
          options.settings.enableSystemTaskCompletionNotifications &&
          (window.desktopBridge || !isWindowForeground())
        )
          void showSystemThreadNotification(copy, completion.threadId, options.navigate);
      },
      (error) => {
        throw error;
      },
    );
    return () => {
      stopBaseline();
      stopChanges();
    };
  }, [threadsHydrated]);

  return null;
}

export function buildNotificationSettingsSupportText(
  permissionState: BrowserNotificationPermissionState,
): string {
  if (isElectron) {
    return "Desktop app notifications use your operating system notification center.";
  }
  switch (permissionState) {
    case "granted":
      return "Browser notifications are enabled for this app.";
    case "denied":
      return "Browser notifications are blocked. Re-enable them in your browser site settings.";
    case "insecure":
      return "Browser notifications need a secure context. Localhost works; plain HTTP does not.";
    case "unsupported":
      return "This browser does not support desktop notifications.";
    case "default":
      return "Allow browser notifications to get alerts when chats finish or need input in the background.";
  }
}
