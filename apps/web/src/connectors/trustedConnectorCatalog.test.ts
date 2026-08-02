import { describe, expect, it } from "vitest";

import { listTrustedConnectors } from "./trustedConnectorCatalog";

describe("trusted connector catalog", () => {
  it("does not advertise integrations without a registered trusted runtime", () => {
    expect(listTrustedConnectors()).toEqual([]);
  });
});
