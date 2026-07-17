import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { toastManager } from "../components/ui/toast";
import { createPenkraClient, penkraQueryKeys } from "./reactQuery";

export function PenkraCreateClientDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [country, setCountry] = useState("");
  const mutation = useMutation({
    mutationFn: createPenkraClient,
    onSuccess: async (client) => {
      await queryClient.invalidateQueries({ queryKey: penkraQueryKeys.snapshot });
      toastManager.add({ title: `${client.displayName} added` });
      setDisplayName("");
      setEmail("");
      setCountry("");
      onOpenChange(false);
    },
  });

  const submit = () => {
    const name = displayName.trim();
    if (!name || mutation.isPending) return;
    mutation.mutate({
      displayName: name,
      ...(email.trim() ? { email: email.trim() } : {}),
      ...(country.trim() ? { country: country.trim().toUpperCase() } : {}),
      idempotencyKey: crypto.randomUUID(),
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup surface="solid" className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Add client</DialogTitle>
          <DialogDescription>The workspace is created and scoped immediately.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          <Input
            autoFocus
            placeholder="Client name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          <Input
            type="email"
            placeholder="Email (optional)"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <Input
            placeholder="Country code (optional)"
            maxLength={2}
            value={country}
            onChange={(event) => setCountry(event.target.value)}
          />
          {mutation.error ? (
            <p className="text-sm text-destructive">{mutation.error.message}</p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!displayName.trim() || mutation.isPending}>
            {mutation.isPending ? "Adding..." : "Add client"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
