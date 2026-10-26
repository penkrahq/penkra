import { Layer } from "effect";
import { RemoteTrustScope } from "./trustStore";

export const remoteTrustOwner = {
  accountServiceUrl: "https://account.example.test",
  accountId: "account-a",
  macDeviceId: "10000000-0000-4000-8000-000000000001",
};
export const remoteTrustScopeLayer = Layer.succeed(RemoteTrustScope, remoteTrustOwner);
