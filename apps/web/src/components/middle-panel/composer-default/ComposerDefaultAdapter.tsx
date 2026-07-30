import type { ReactNode } from "react";

import { ComposerDefault } from "./ComposerDefault";

export function ComposerDefaultAdapter({ children }: { children: ReactNode }) {
  return <ComposerDefault layoutMode="application">{children}</ComposerDefault>;
}
