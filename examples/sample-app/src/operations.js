import { operations } from "@penkra/sdk";
operations.handle("notes.create", async ({ text, confirm }, context) => confirm
  ? context.tabs.openForResult({ route: "/notes/new", state: { text } })
  : { saved: text.trim().length > 0 });
