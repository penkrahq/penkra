import { useSearch } from "@tanstack/react-router";

import { createStableChatRouteSearchSelector } from "../chatRouteSearch";

const selectStableChatRouteSearch = createStableChatRouteSearchSelector();

export function useChatRouteSearch() {
  return useSearch({
    strict: false,
    select: selectStableChatRouteSearch,
  });
}
