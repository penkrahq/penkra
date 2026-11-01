// Purpose: Promote an in-memory composer draft and send its first message in one operation.
import type {
  CleanCoreCreateAndSendThreadInput,
  CleanCoreSendMessageInput,
} from "@penkra/contracts";
import { Effect } from "effect";
import { ThreadSender } from "./ThreadSender.ts";
import { createThreadFromClient } from "./threadLifecycle.ts";
import { encodeUserItemAdmission } from "./userItemAdmission.ts";

export const createAndSendThread = (
  input: CleanCoreCreateAndSendThreadInput,
  origin: CleanCoreSendMessageInput["message"]["origin"],
) =>
  Effect.gen(function* () {
    const { thread, ...client } = input;
    const send = { ...client, message: { ...client.message, origin } };
    yield* encodeUserItemAdmission(send, send.dispatchMode === "steer");
    const created = yield* createThreadFromClient(thread);
    const sender = yield* ThreadSender;
    const sendResult = yield* sender.send({ ...send, threadId: thread.threadId });
    return { ...created, sendResult };
  });
