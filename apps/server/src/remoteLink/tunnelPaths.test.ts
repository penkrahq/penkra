import { describe, expect, it } from "vitest";
import { WS_COMPATIBILITY_QUERY } from "@penkra/contracts";
import { resolveTunnelPath } from "./tunnelPaths";

describe("RemoteLink tunnel paths", () => {
  it.each([
    "https://outside.example/attachments/file",
    "//outside.example/attachments/file",
    "/\\outside.example/attachments/file",
    "/attachments/../api/secrets",
    "/attachments/%2e%2e/api/secrets",
    "/attachments/file#fragment",
    "/attachments/file?token=owner",
    "/attachments/",
    "/attachments/file\n",
    "/api/attachments/upload/extra",
    "/api/voice/transcribe/",
    "/healthz",
    "/api/auth/sessions",
  ])("refuses forbidden paths: %s", (path) => {
    expect(() => resolveTunnelPath({ kind: "http", method: "GET", path })).toThrow();
  });
  it("refuses extra WebSocket routes, authority query parameters, and method confusion", () => {
    for (const path of [
      "/ws?token=owner",
      "/ws?unexpected=value",
      "/ws/other",
      "/attachments/file",
      `/ws?${WS_COMPATIBILITY_QUERY.clientBuild}=a&${WS_COMPATIBILITY_QUERY.clientBuild}=b`,
    ])
      expect(() => resolveTunnelPath({ kind: "ws", method: "GET", path })).toThrow();
    expect(() => resolveTunnelPath({ kind: "ws", method: "POST", path: "/ws" })).toThrow();
    expect(() =>
      resolveTunnelPath({ kind: "http", method: "DELETE", path: "/api/attachments/upload" }),
    ).toThrow();
    expect(() =>
      resolveTunnelPath({ kind: "http", method: "POST", path: "/attachments/file" }),
    ).toThrow();
    for (const path of [
      "/api/attachments/upload/extra",
      "/api/voice/transcribe/",
      "/api/attachments/cancel/extra",
    ])
      expect(() => resolveTunnelPath({ kind: "http", method: "POST", path })).toThrow();
    expect(
      resolveTunnelPath({
        kind: "http",
        method: "GET",
        path: "/api/thread-export?threadId=thread-1",
      }),
    ).toBe("/api/thread-export?threadId=thread-1");
    const encodedID = "/api/thread-export?threadId=a%2Bb%26c%23d%25%20%2F%F0%9F%92%A1";
    const resolved = resolveTunnelPath({ kind: "http", method: "GET", path: encodedID });
    expect(new URL(resolved, "http://127.0.0.1").searchParams.get("threadId")).toBe("a+b&c#d% /💡");
    for (const path of [
      "/api/thread-export",
      "/api/thread-export?threadId=",
      "/api/thread-export?threadId=a&threadId=b",
      "/api/thread-export?threadId=a&other=b",
      "/api/thread-export?threadId=a&token=owner",
      "/api/thread-export?threadId=%0A",
      "/api/thread-export?threadId=a%00b",
      "/api/thread-export/extra?threadId=a",
      `/api/thread-export?threadId=${"a".repeat(2049)}`,
    ])
      expect(() => resolveTunnelPath({ kind: "http", method: "GET", path })).toThrow();
    expect(() =>
      resolveTunnelPath({ kind: "http", method: "POST", path: "/api/thread-export?threadId=a" }),
    ).toThrow();
  });
});
