import { usePaginatedQuery, useQuery } from "convex/react";
import { useMemo } from "react";

import { getHead, listHeadsPage } from "./functions";
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

/**
 * One session head, subscribed.
 *
 * The session screen is reachable by link, so it cannot assume the paginated
 * list has already loaded the session it was asked to open. Convex deduplicates
 * identical subscriptions, so this shares the socket with the tails that read
 * the same head for their stream epochs.
 */
export function useSessionHead(sessionPublicId: string | null): SessionHead | null {
  const value = useQuery(
    getHead,
    sessionPublicId === null ? "skip" : { publicId: sessionPublicId },
  );
  return useMemo(() => value === undefined ? null : parseSessionHead(value), [value]);
}
