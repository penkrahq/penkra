import * as Effect from "effect/Effect";

// Private Production builds briefly recorded this identity while exercising
// bounded runtime maintenance. Keep the tracker ID/name reserved so those
// databases stay on the canonical lineage; the objects it created are unused by
// this build, so there is nothing to re-run.
export default Effect.void;
