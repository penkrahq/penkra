import type { ReactNode } from "react";

import { MessageUser } from "./MessageUser";

export function MessageUserAdapter({ children }: { children: ReactNode }) {
  return <MessageUser layoutMode="application">{children}</MessageUser>;
}
