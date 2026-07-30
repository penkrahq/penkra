import type { ReactNode } from "react";

import { MessageAssistant } from "./MessageAssistant";

export function MessageAssistantAdapter({ children }: { children: ReactNode }) {
  return <MessageAssistant layoutMode="application">{children}</MessageAssistant>;
}
