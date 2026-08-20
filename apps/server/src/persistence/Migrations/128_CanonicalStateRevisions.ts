import * as Effect from "effect/Effect";

// Reserved migration number. Row-delta revisions were removed before they gained a reader;
// shell and Thread synchronization use sequence-fenced snapshots plus domain-event streams.
export default Effect.void;
