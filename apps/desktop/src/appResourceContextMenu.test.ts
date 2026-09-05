import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildAppResourceContextMenu } from "./appResourceContextMenu";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => FS.promises.rm(directory, { recursive: true, force: true })),
  );
});

describe("buildAppResourceContextMenu", () => {
  it("puts the external browser before URL handlers discovered from Apps", async () => {
    const candidates = () => [
      {
        appId: "com.acme.web",
        slug: "web",
        name: "Acme Web",
        operation: "links.open",
      },
    ];

    await expect(
      buildAppResourceContextMenu({
        intents: { candidates } as never,
        platform: "darwin",
        request: {
          url: "https://example.com/report",
          spaceId: "personal",
          threadId: "thread-1",
          position: { x: 12, y: 24 },
        },
      }),
    ).resolves.toMatchObject({
      label: "Open in",
      intent: "open-url",
      resource: { url: "https://example.com/report" },
      choices: [
        { id: "system", label: "External Browser", destination: "system" },
        {
          id: "app:com.acme.web",
          label: "Acme Web",
          destination: "app",
          requestedApp: "com.acme.web",
        },
      ],
    });
  });

  it("puts Finder before exact file handlers on macOS", async () => {
    const directory = await temporaryDirectory();
    const path = Path.join(directory, "report.PDF");
    await FS.promises.writeFile(path, "data");
    const requests: unknown[] = [];
    const candidates = (_spaceId: string, request: unknown) => {
      requests.push(request);
      return [
        {
          appId: "com.acme.reader",
          slug: "reader",
          name: "Reader",
          operation: "files.open",
        },
      ];
    };

    const model = await buildAppResourceContextMenu({
      intents: { candidates } as never,
      platform: "darwin",
      request: {
        path,
        spaceId: "personal",
        threadId: "thread-1",
        position: { x: 12, y: 24 },
      },
    });

    expect(requests).toEqual([{ intent: "open-file", extension: ".pdf" }]);
    expect(model.choices).toEqual([
      { id: "system", label: "Finder", destination: "system" },
      {
        id: "app:com.acme.reader",
        label: "Reader",
        destination: "app",
        requestedApp: "com.acme.reader",
      },
    ]);
  });

  it("does not invent a local system App name on non-macOS platforms", async () => {
    const directory = await temporaryDirectory();
    const model = await buildAppResourceContextMenu({
      intents: { candidates: () => [] } as never,
      platform: "win32",
      request: {
        path: directory,
        spaceId: "personal",
        threadId: "thread-1",
        position: { x: 12, y: 24 },
      },
    });

    expect(model).toMatchObject({ label: "Show in", intent: "open-directory", choices: [] });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await FS.promises.mkdtemp(Path.join(OS.tmpdir(), "penkra-resource-menu-"));
  temporaryDirectories.push(directory);
  return FS.promises.realpath(directory);
}
