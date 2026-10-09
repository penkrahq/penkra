import * as Effect from "effect/Effect";

// Private Production builds briefly recorded this identity while adding purge
// ownership indexes. Reserved so those databases stay on the canonical lineage;
// the indexes it created are unused by this build.
export default Effect.void;
