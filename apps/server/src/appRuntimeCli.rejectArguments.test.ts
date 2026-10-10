// FILE: appRuntimeCli.rejectArguments.test.ts
// Purpose: Pins the exact errors for tokens a structured penkra command does not accept.
// Layer: Server CLI tests

import { expect, it } from "vitest";
import { rejectUnacceptedArguments } from "./appRuntimeCli.ts";

it("names the bare value and the --field-name form instead of a generic error", () => {
  expect(() =>
    rejectUnacceptedArguments(
      "penkra threads read",
      { positionals: ["agent-1", "extra"] },
      { acceptsTabId: false },
    ),
  ).toThrow(
    'penkra threads read received the bare value "agent-1". Every input field is passed by name as --field-name value (for example --thread-id <id>, not <id> alone). Run penkra threads read --help for its input fields.',
  );
});

it("names --tab-id when the command does not accept it, and allows it where accepted", () => {
  expect(() =>
    rejectUnacceptedArguments(
      "penkra threads read",
      { positionals: [], tabId: "tab-1" },
      { acceptsTabId: false },
    ),
  ).toThrow(
    "penkra threads read does not accept --tab-id. Run penkra threads read --help for its input fields.",
  );
  expect(() =>
    rejectUnacceptedArguments(
      "penkra tabs snapshot",
      { positionals: [], tabId: "tab-1" },
      { acceptsTabId: true },
    ),
  ).not.toThrow();
});
