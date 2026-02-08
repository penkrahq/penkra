type MaybePromise<T> = T | Promise<T>;
type Parser<T> = {
  parse: (value: unknown) => T;
};
type ArgsParser<T extends unknown[]> = {
  parse: (value: unknown[]) => T;
};

export function withParsedPayload<TPayload, TResult>(
  schema: Parser<TPayload>,
  handler: (event: unknown, payload: TPayload) => MaybePromise<TResult>,
): (event: unknown, payload: unknown) => MaybePromise<TResult> {
  return (event, payload) => handler(event, schema.parse(payload));
}

export function withParsedArgs<TArgs extends unknown[], TResult>(
  schema: ArgsParser<TArgs>,
  handler: (event: unknown, ...args: TArgs) => MaybePromise<TResult>,
): (event: unknown, ...args: unknown[]) => MaybePromise<TResult> {
  return (event, ...args) => {
    const parsedArgs = schema.parse(args);
    return handler(event, ...parsedArgs);
  };
}
