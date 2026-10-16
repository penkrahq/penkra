# Chore OpenCode image investigation, 2026-10-13

Report only. No product code, Production database, native session, plugin installation or account configuration was changed.

## Version and exact failing function

Chore is Penkra thread `919c1fb3-9437-4431-ba0e-e90f3c836dd5`, native session `ses_f2297bda1ffe0QrBBnikfilOc5`. The process inspected was PID 23837, serving localhost:57129. Its executable is `~/Penkra/.penkra/userdata/provider-runtimes/opencode/versions/1.19.0/opencode`; both `--version` and GET `/global/health` report 1.19.0.

The installed binary contains this exact compiled function:

```js
function N5(Q) {
  return Q.startsWith("image/") || o9(Q);
}
```

It also contains the tool-attachment filters `T.filter((c)=>N5(c.mime))` and `T.filter((c)=>!N5(c.mime)||H(c))`. This matches [v1.19.0 isMedia, lines 7–8](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/util/media.ts#L7) and [toModelMessagesEffect, lines 288–305](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/session/message-v2.ts#L288): the converter filters completed tool attachments by MIME, then prepares their output. The observed error is specifically the MIME check, not the later URL check.

## Read-only Chore history

Used GET `/session` and GET `/session/<id>/message` on the existing OpenCode service; no prompt or mutation was sent to it and no SQLite file was opened. The title is `Penkra 919c1fb3-9437-4431-ba0e-e90f3c836dd5`.

The API returned 1,008 messages, including **32 completed `read` tool parts whose state.attachments contain PNG files**. All 32 retain `type: file`, `mime: image/png`, and a `data:` URL. None has a missing MIME or URL. A metadata-only summary is `/tmp/penkra-opencode-history-report.json`.

Therefore the stored native attachment records are intact. Our `experimental.chat.messages.transform` hook recursively walks every older message's parts, including `tool.state.attachments`. `toTextPart` replaces each image attachment with a text object, deleting mime and url. The converter then receives undefined for `c.mime`, so N5 throws. Repeating a send repeats the same in-memory transformation; this does not require corrupt stored history.

## Isolated native reproduction

Scratch root: `~/penkra-rehearsal/opencode-image-repro`. Each native server got its own scratch PENKRA_HOME, OPENCODE_TEST_HOME and XDG config/data/state/cache paths. Used the exact installed 1.19.0 binary, a local OpenAI-compatible fixture endpoint, and a declared image-capable fixture model. No real credentials or remote model requests were used.

This is a native provider-session control, not a full Penkra UI run: it isolates the plugin and OpenCode converter while removing composer/gateway/network-service variation. The first prompt invokes the actual native `read` tool on a real PNG. Then a second message is sent. One run was performed per case; process readiness and request/child completion drove it, with no sleeps, retries or mutation of Chore.

| Case                         | First prompt after image tool result                | Second prompt             | Model requests                                |
| ---------------------------- | --------------------------------------------------- | ------------------------- | --------------------------------------------- |
| Exact current plugin enabled | HTTP 500, exact Q.startsWith/N5 failure             | HTTP 500, same failure    | 1 for first tool invocation; 0 on second send |
| Plugin absent                | HTTP 200, tool result processed and reply completed | HTTP 200, reply completed | 2 for first turn; 1 for second                |

Both native histories retain the completed read attachment as a valid PNG file. Plugin-on fails on the first turn's next loop after the image result, not only after an additional user message. It remains able to accept HTTP requests; this is a prompt failure, not proof that the server process exited.

Evidence: `opencode-image-repro/report.json`, `plugin-on/native.log`, `plugin-off/native.log`, and `run.mjs`. The isolated failure has the same `chunk-w4z2p0ej.js:9:7114`, filter frame, and `SessionPrompt.run` frames as Chore. The harness used the synchronous native prompt route; Chore used promptAsync, whose wrapper appears at the bottom of its stack.

## Release boundary

v0.14.3 contains no Penkra image-transform plugin or injection. `8ef20ddcb` introduced both the plugin and the recursive nested-tool-attachment rewrite. It already deletes mime/url for `type:file, mime:image/png`. `bdf3513be` narrowed image recognition but retained that recursion and field deletion, so it did not remove this failure.

The same-binary plugin-off control succeeds, establishing the plugin as the cause. A whole v0.14.3 app was not run; baseline source comparison shows the offending hook was absent there. This is a newly introduced plugin failure, not an inherent inability of OpenCode 1.19.0 to process the valid stored tool image.

No fix proposed or applied in this report; the requested design decision remains with the reviewer/operator.
