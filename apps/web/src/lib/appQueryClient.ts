import { QueryClient } from "@tanstack/react-query";

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    // Surface failures immediately; the user decides when to retry (operator decision 8).
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}
