/**
 * OpenCodeAdapter - OpenCode implementation of the generic provider adapter contract.
 *
 * This service owns OpenCode runtime/session semantics and emits canonical
 * provider runtime events. It does not perform cross-provider routing.
 *
 * @module OpenCodeAdapter
 */
import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface OpenCodeAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "opencode";
}

export class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "penkra/provider/Services/OpenCodeAdapter",
) {}
