import { WS_BOOTSTRAP_PATH, WS_FEATURE_PATH, WS_COMPATIBILITY_QUERY } from "@penkra/contracts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PATH,
  ATTACHMENT_CANCEL_ROUTE_PATH,
  VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH,
} from "@penkra/shared/binaryTransfer";
import { ATTACHMENTS_ROUTE_PREFIX } from "../attachmentPaths";

export class TunnelPathError extends Error {
  readonly code = "forbidden-path";
  constructor() {
    super("This path is not available through RemoteLink.");
    this.name = "TunnelPathError";
  }
}

/** Returns a canonical relative path only. The caller owns the loopback origin and credential. */
export function resolveTunnelPath(input: {
  kind: "ws" | "http";
  method: string;
  path: string;
}): string {
  if (
    !input.path.startsWith("/") ||
    input.path.startsWith("//") ||
    /[\p{Cc}\s\\]/u.test(input.path)
  )
    throw new TunnelPathError();
  let url: URL;
  try {
    url = new URL(input.path, "http://127.0.0.1");
  } catch {
    throw new TunnelPathError();
  }
  if (url.origin !== "http://127.0.0.1" || url.hash || url.searchParams.has("token"))
    throw new TunnelPathError();
  if (input.kind === "ws") {
    if (
      input.method !== "GET" ||
      (url.pathname !== WS_BOOTSTRAP_PATH && url.pathname !== WS_FEATURE_PATH)
    )
      throw new TunnelPathError();
    const allowed: ReadonlySet<string> = new Set(Object.values(WS_COMPATIBILITY_QUERY));
    for (const key of url.searchParams.keys())
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1)
        throw new TunnelPathError();
  } else {
    const download =
      input.method === "GET" &&
      url.pathname.startsWith(`${ATTACHMENTS_ROUTE_PREFIX}/`) &&
      url.pathname.length > ATTACHMENTS_ROUTE_PREFIX.length + 1;
    const upload =
      input.method === "POST" &&
      [
        ATTACHMENT_UPLOAD_ROUTE_PATH,
        ATTACHMENT_CANCEL_ROUTE_PATH,
        VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH,
      ].some((path) => path === url.pathname);
    if (!download && !upload) throw new TunnelPathError();
  }
  return `${url.pathname}${url.search}`;
}
