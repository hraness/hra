/**
 * The reader's manual grid order.
 *
 * The grid's automatic ladder (attention, then working, then last activity)
 * decides the order until the reader drags a card. From then on the manual
 * sequence decides it, inside the attention grouping, so a card that wants a
 * human still floats to the front of a hand-arranged grid.
 *
 * Everything here is a pure fold over a list of session public ids. It imports
 * no React, touches no document, and reaches the browser only through the
 * `CardOrderStorage` port, so `bun test ./app` proves the reducer and the
 * storage fallback without a window.
 *
 * What is persisted: opaque session public ids and nothing else. No projection
 * text, no name, no token, and no key. A reader who clears site data loses an
 * arrangement, which is the whole cost of losing it.
 */

/** The one key this app writes outside IndexedDB. Versioned so a shape change is a new key. */
export const cardOrderStorageKey = "hra.grid-order.v1";

/** A bound on the stored list, so an account with many sessions cannot grow it without end. */
export const maximumOrderedCards = 200;

/** A session public id is opaque and short; anything longer is not one. */
export const maximumOrderedIdCharacters = 200;

/**
 * The browser storage seam.
 *
 * Every method may throw: a browser in private mode, a profile with site data
 * blocked, and an over-quota write all raise rather than return. The callers
 * below treat a throw as "no stored order", never as an error to report.
 */
export type CardOrderStorage = Readonly<{
  read: () => string | null;
  remove: () => void;
  write: (value: string) => void;
}>;

export type CardOrderAction =
  /** Forget the manual arrangement and fall back to the automatic ladder. */
  | Readonly<{ type: "clear" }>
  /** Replace the arrangement with one read back from storage. */
  | Readonly<{ order: readonly string[]; type: "restore" }>
  /** Drop the dragged card onto the position another card currently holds. */
  | Readonly<{
      activePublicId: string;
      displayed: readonly string[];
      overPublicId: string;
      type: "move";
    }>
  /** The keyboard path: one step left or right in the displayed sequence. */
  | Readonly<{
      direction: "left" | "right";
      displayed: readonly string[];
      publicId: string;
      type: "nudge";
    }>;

/**
 * A stored value parsed from `unknown`.
 *
 * Local storage is writable by anything else served from this origin and by the
 * reader's own devtools, so the stored value is foreign input like any other:
 * it is bounded, de-duplicated, and stripped of everything that is not a
 * plausible public id.
 */
export function normaliseCardOrder(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== "string") continue;
    if (entry.length === 0 || entry.length > maximumOrderedIdCharacters) continue;
    seen.add(entry);
    if (seen.size >= maximumOrderedCards) break;
  }
  return [...seen];
}

/** The stored text parsed into an order. Malformed JSON reads as no order. */
export function parseCardOrder(text: string | null): readonly string[] {
  if (text === null) return [];
  try {
    return normaliseCardOrder(JSON.parse(text));
  } catch {
    return [];
  }
}

/** The stored order, or none when storage is unavailable, empty, or throwing. */
export function readCardOrder(storage: CardOrderStorage): readonly string[] {
  try {
    return parseCardOrder(storage.read());
  } catch {
    return [];
  }
}

/**
 * Persist the order, or give up quietly.
 *
 * An empty order removes the key rather than storing an empty list, so a reader
 * who resets the arrangement leaves nothing behind.
 */
export function writeCardOrder(
  storage: CardOrderStorage,
  order: readonly string[],
): void {
  try {
    if (order.length === 0) storage.remove();
    else storage.write(JSON.stringify(order.slice(0, maximumOrderedCards)));
  } catch {
    // Storage refused the write. The arrangement still holds for this session;
    // it simply will not survive a reload.
  }
}

/**
 * Move one id to an index inside the displayed sequence.
 *
 * The index is where the card should end up, not where the card it displaced
 * used to be, so a step to the right actually steps right: removing the card
 * first and inserting at the same index would leave it where it was.
 */
export function moveToIndex(
  displayed: readonly string[],
  publicId: string,
  toIndex: number,
): readonly string[] {
  const from = displayed.indexOf(publicId);
  if (from < 0 || displayed.length === 0) return displayed;
  const clamped = Math.min(Math.max(toIndex, 0), displayed.length - 1);
  if (clamped === from) return displayed;
  const rest = displayed.filter((entry) => entry !== publicId);
  return [...rest.slice(0, clamped), publicId, ...rest.slice(clamped)];
}

/**
 * Fold a rearranged page back into the stored order.
 *
 * The grid paginates, so the reader arranges the page they can see. Ids the
 * stored order holds that this page does not carry keep their arrangement and
 * follow the page, rather than being dropped because they were off screen.
 */
function merge(
  order: readonly string[],
  page: readonly string[],
): readonly string[] {
  const onPage = new Set(page);
  const retained = order.filter((entry) => !onPage.has(entry));
  return normaliseCardOrder([...page, ...retained]);
}

/**
 * The manual order after one reader action.
 *
 * The first drag seeds the arrangement from what the reader is already looking
 * at, which is the automatic ladder's own output: the grid does not jump when
 * manual ordering begins, it simply stops moving on its own.
 */
export function cardOrderReducer(
  order: readonly string[],
  action: CardOrderAction,
): readonly string[] {
  switch (action.type) {
    case "clear":
      return [];
    case "restore":
      return normaliseCardOrder([...action.order]);
    case "move": {
      if (action.activePublicId === action.overPublicId) return order;
      const toIndex = action.displayed.indexOf(action.overPublicId);
      if (toIndex < 0 || !action.displayed.includes(action.activePublicId)) return order;
      return merge(order, moveToIndex(action.displayed, action.activePublicId, toIndex));
    }
    case "nudge": {
      const from = action.displayed.indexOf(action.publicId);
      if (from < 0) return order;
      const toIndex = from + (action.direction === "left" ? -1 : 1);
      if (toIndex < 0 || toIndex >= action.displayed.length) return order;
      return merge(order, moveToIndex(action.displayed, action.publicId, toIndex));
    }
  }
}

/** Whether the card can still step that way, for a disabled menu item. */
export function canNudge(
  displayed: readonly string[],
  publicId: string,
  direction: "left" | "right",
): boolean {
  const from = displayed.indexOf(publicId);
  if (from < 0) return false;
  return direction === "left" ? from > 0 : from < displayed.length - 1;
}
