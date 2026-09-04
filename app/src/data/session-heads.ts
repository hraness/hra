import { usePaginatedQuery } from "convex/react";
import { useMemo } from "react";

import { listHeadsPage } from "./functions";
import { parseSessionHead, type SessionHead } from "./wire";

export type SessionHeadsPage = Readonly<{
  heads: readonly SessionHead[];
  isLoading: boolean;
  loadMore: (count: number) => void;
  status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted";
}>;

/**
 * The paginated session list, subscribed rather than polled: a head update on
 * the daemon reaches the grid over the same websocket the CSP admits.
 */
export function useSessionHeads(initialNumItems = 24): SessionHeadsPage {
  const page = usePaginatedQuery(listHeadsPage, {}, { initialNumItems });
  const heads = useMemo(
    () => page.results
      .map((entry) => parseSessionHead(entry))
      .filter((entry): entry is SessionHead => entry !== null),
    [page.results],
  );
  return {
    heads,
    isLoading: page.isLoading,
    loadMore: page.loadMore,
    status: page.status,
  };
}
