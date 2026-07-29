import type { ComponentProps } from "react";

import { ButtonPrimary } from "../button-primary/ButtonPrimary";

export type ButtonSaveProps = ComponentProps<typeof ButtonPrimary>;

export function ButtonSave({ children = "Save", ...props }: ButtonSaveProps) {
  return <ButtonPrimary {...props}>{children}</ButtonPrimary>;
}
