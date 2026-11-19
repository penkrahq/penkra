// FILE: repetitionGuard.ts
// Purpose: Notices when a local model is stuck repeating the same text, so the
// proxy can end the turn instead of letting it run to the token limit.
// Layer: Local provider runtime

/** Shortest stretch of exact repetition that counts as a loop. */
const MIN_LOOP_CHARS = 1_000;
/** A loop must repeat its unit at least this many times. */
const MIN_REPEATS = 6;
/** Longest repeating unit looked for (a line or a short paragraph). */
const MAX_PERIOD = 400;
const WINDOW = MAX_PERIOD * MIN_REPEATS + MIN_LOOP_CHARS;
const CHECK_EVERY = 64;

/**
 * Feed it the model's streamed text (reasoning, answer and tool arguments).
 * `push` returns true once the tail of the text is one unit repeated over and
 * over. Real code and prose almost never repeat exactly for this long.
 */
export class RepetitionGuard {
  #tail = "";
  #sinceCheck = 0;

  push(text: string): boolean {
    if (!text) return false;
    this.#tail = (this.#tail + text).slice(-WINDOW);
    this.#sinceCheck += text.length;
    if (this.#sinceCheck < CHECK_EVERY) return false;
    this.#sinceCheck = 0;
    return isLooping(this.#tail);
  }
}

export function isLooping(text: string): boolean {
  const n = text.length;
  if (n < MIN_LOOP_CHARS) return false;
  for (let period = 1; period <= MAX_PERIOD; period++) {
    const needed = Math.max(MIN_LOOP_CHARS, period * MIN_REPEATS);
    if (needed + period > n) break;
    let run = 0;
    for (let i = n - 1; i >= period && text[i] === text[i - period]; i--) {
      if (++run >= needed) return true;
    }
  }
  return false;
}
