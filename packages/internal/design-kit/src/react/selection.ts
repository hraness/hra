import type { Key } from "react-aria-components";

interface StringIdentified<Id extends string> {
  readonly id: Id;
}

export function ownedStringIdForKey<Id extends string>(
  items: readonly StringIdentified<Id>[],
  key: Key,
): Id | null {
  const candidate = String(key);
  return items.find((item) => item.id === candidate)?.id ?? null;
}

export function firstOwnedStringId<Id extends string>(
  items: readonly StringIdentified<Id>[],
  keys: Iterable<Key>,
): Id | null {
  const first = keys[Symbol.iterator]().next();
  return first.done ? null : ownedStringIdForKey(items, first.value);
}
