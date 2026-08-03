import type { ComponentProps } from "react";

import { ComposerActions } from "../composer-actions/ComposerActions";

export function ComposerActionsEmptyThread(props: ComponentProps<typeof ComposerActions>) {
  return <ComposerActions {...props} pencilComponentId="BtaMG" />;
}
