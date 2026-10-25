/** Controlled event gates for desktop tests, using the desktop's ES2023 target. */
export function deferred<A = void>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
