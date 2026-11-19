/**
 * LocalAdapter - on-device models. Runs the OpenCode harness against Penkra's
 * loopback MLX proxy; OpenCode is never shown to the user.
 *
 * @module LocalAdapter
 */
import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface LocalAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "local";
}

export class LocalAdapter extends Context.Service<LocalAdapter, LocalAdapterShape>()(
  "penkra/provider/Services/LocalAdapter",
) {}
