import { CommandId, MessageId, FolderId, SpaceId, ThreadId } from "@penkra/contracts";
import { type CxOptions, cx } from "class-variance-authority";
import { twMerge } from "tailwind-merge";
import * as Effect from "effect/Effect";

export function cn(...inputs: CxOptions) {
  return twMerge(cx(inputs));
}

export function isMacPlatform(platform: string): boolean {
  return /mac|darwin|iphone|ipad|ipod/i.test(platform);
}

export function isWindowsPlatform(platform: string): boolean {
  return /^win(dows)?/i.test(platform);
}

export function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return Effect.runSync(Effect.sync(() => crypto.randomUUID()));
}

export const newCommandId = (): CommandId => CommandId.make(randomUUID());

export const newFolderId = (): FolderId => FolderId.make(randomUUID());

export const newSpaceId = (): SpaceId => SpaceId.make(randomUUID());

export const newThreadId = (): ThreadId => ThreadId.make(randomUUID());

export const newMessageId = (): MessageId => MessageId.make(randomUUID());
