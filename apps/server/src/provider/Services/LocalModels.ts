/**
 * LocalModels - the Local provider's on-device model service (catalog, downloads,
 * loopback proxy). One instance per server.
 *
 * @module LocalModels
 */
import { Context } from "effect";

import type { LocalModelService } from "../localModels/localModelService.ts";

export class LocalModels extends Context.Service<LocalModels, LocalModelService>()(
  "penkra/provider/Services/LocalModels",
) {}
