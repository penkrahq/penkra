import { operations } from "@penkra/sdk/controller";
operations.handle("notes.create", async ({ text, confirm }, context) =>
  confirm
    ? context.tabs.openForResult({ route: "/notes/new", state: { text } })
    : { saved: text.trim().length > 0 },
);

operations.handle("catalog.open-listing", async ({ appId }, context) =>
  context.operations.invoke({
    app: "apps",
    operation: "listings.open",
    input: { appId },
  }),
);
