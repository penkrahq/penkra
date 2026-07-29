import { IconChevronDown, IconShieldCheck } from "@tabler/icons-react";

export interface AccessPillContentProps {
  label?: string;
}

export function AccessPillContent({ label = "Full access" }: AccessPillContentProps) {
  return (
    <>
      <IconShieldCheck className="size-[13px]" />
      <span>{label}</span>
      <IconChevronDown className="size-[11px]" />
    </>
  );
}
