import { useQueryClient } from "@tanstack/react-query";
import type { ServerConfigUpdatedPayload } from "@penkra/contracts";
import { useEffect } from "react";

import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { serverQueryKeys, serverConfigQueryOptions } from "../lib/serverReactQuery";
import { readNativeApi } from "../nativeApi";
import { onServerConfigUpdated } from "../wsNativeApi";
import { toastManager } from "./ui/toast";

interface ServerConfigUpdateNotificationsProps {
  readonly onSubscribed?: (() => void) | undefined;
  readonly subscribe?: ServerConfigUpdateSubscription | undefined;
}

export type ServerConfigUpdateSubscription = (
  listener: (payload: ServerConfigUpdatedPayload) => void,
) => () => void;

/** Owns live server-config notifications independently of orchestration hydration. */
export function ServerConfigUpdateNotifications({
  onSubscribed,
  subscribe = onServerConfigUpdated,
}: ServerConfigUpdateNotificationsProps = {}) {
  const queryClient = useQueryClient();

  useEffect(() => {
    let subscribed = false;
    const unsubscribe = subscribe((payload) => {
      void queryClient.invalidateQueries({
        queryKey: serverQueryKeys.config(),
      });
      if (!subscribed) return;
      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) return;

      toastManager.add({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: issue.message,
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            const api = readNativeApi();
            if (!api) {
              toastManager.add({
                type: "error",
                title: "Unable to open keybindings file",
                description: "Native API not found.",
              });
              return;
            }
            void queryClient
              .ensureQueryData(serverConfigQueryOptions())
              .then((config) => {
                const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                if (!editor) throw new Error("No available editors found.");
                return api.shell.openInEditor(config.keybindingsConfigPath, editor);
              })
              .catch((error) => {
                toastManager.add({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                });
              });
          },
        },
      });
    });
    subscribed = true;
    onSubscribed?.();
    return unsubscribe;
  }, [onSubscribed, queryClient, subscribe]);

  return null;
}
