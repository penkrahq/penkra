import { useQuery } from "@tanstack/react-query";

import ChatMarkdown from "../components/ChatMarkdown";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { penkraInstructionsQueryOptions } from "./reactQuery";

export type PenkraInstructionsTarget =
  | { kind: "hq" }
  | { kind: "client"; clientId: string; displayName: string };

export function PenkraInstructionsDialog({
  target,
  onOpenChange,
}: {
  target: PenkraInstructionsTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const isHq = target?.kind === "hq";
  const hqQuery = useQuery({
    ...penkraInstructionsQueryOptions({ scope: "hq" }),
    enabled: target !== null && isHq,
  });
  const genericClientQuery = useQuery({
    ...penkraInstructionsQueryOptions({ scope: "client" }),
    enabled: target !== null && isHq,
  });
  const clientQuery = useQuery({
    ...penkraInstructionsQueryOptions({
      scope: "client-specific",
      clientId: target?.kind === "client" ? target.clientId : "unselected",
    }),
    enabled: target?.kind === "client",
  });

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogPopup surface="solid" className="max-w-3xl gap-0 p-0">
        <DialogHeader className="gap-1 border-b p-4 pr-12">
          <DialogTitle className="text-base">
            {target?.kind === "client"
              ? `${target.displayName} instructions`
              : "Penkra instructions"}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Read directly from the Penkra backend. Local workspace files are not used here.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="max-h-[min(72vh,720px)] space-y-6 px-5 py-4">
          {target?.kind === "hq" ? (
            <>
              <InstructionSection
                title="HQ (hq.md)"
                body={hqQuery.data?.body}
                loading={hqQuery.isPending}
                error={hqQuery.error}
              />
              <InstructionSection
                title="All clients (client.md)"
                body={genericClientQuery.data?.body}
                loading={genericClientQuery.isPending}
                error={genericClientQuery.error}
              />
            </>
          ) : target?.kind === "client" ? (
            <InstructionSection
              title="Client-specific"
              body={clientQuery.data?.body}
              loading={clientQuery.isPending}
              error={clientQuery.error}
              emptyMessage={`No client-specific instructions are set. Add them from ${target.displayName}'s work panel or with penkra client update ${target.clientId}.`}
            />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function InstructionSection({
  title,
  body,
  loading,
  error,
  emptyMessage = "This remote instruction document is empty.",
}: {
  title: string;
  body: string | undefined;
  loading: boolean;
  error: Error | null;
  emptyMessage?: string;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {error ? <p className="text-sm text-destructive">{error.message}</p> : null}
      {!loading && !error && body === "" ? (
        <div className="rounded-md border border-dashed px-4 py-5 text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      ) : null}
      {body ? (
        <div className="rounded-md border bg-muted/20 px-4 py-3">
          <ChatMarkdown text={body} cwd={undefined} isStreaming={false} />
        </div>
      ) : null}
    </section>
  );
}
