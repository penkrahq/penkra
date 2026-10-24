import { isLoopbackHost } from "../startupAccess";

export function loopbackOrigin(value: string): URL {
  const origin = new URL(value);
  if (
    origin.protocol !== "http:" ||
    !isLoopbackHost(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid RemoteLink loopback origin.");
  return origin;
}
