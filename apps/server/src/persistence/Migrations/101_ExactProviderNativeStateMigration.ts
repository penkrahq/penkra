import * as Effect from "effect/Effect";

// Migration 101 shipped under this tracker identity. Its original one-time
// legacy-state journal has been retired; retain only the immutable lineage
// entry so databases created by shipped builds remain compatible with the
// canonical migration ledger.
export default Effect.void;
