import type { AuthorityTuple, CommandState } from "./contracts";

export type CommandTransitionDisposition =
  | Readonly<{ kind: "applied"; next: CommandState }>
  | Readonly<{ kind: "replay"; next: CommandState }>
  | Readonly<{ kind: "rejected"; reason: "terminal" | "invalid_transition" }>;

export type IdempotencyDisposition =
  | "new"
  | "replay"
  | "conflict";

export type StoredIdempotency = Readonly<{
  requestDigest: string;
}>;

const transitions: Readonly<Record<CommandState, readonly CommandState[]>> = {
  ambiguous: [],
  applied: [],
  cancelled: [],
  effect_started: ["applied", "failed", "ambiguous"],
  expired: [],
  failed: [],
  pending: ["prepared", "cancelled", "expired"],
  prepared: ["effect_started", "cancelled", "expired"],
};

export function commandTransitionDisposition(
  current: CommandState,
  next: CommandState,
): CommandTransitionDisposition {
  if (current === next) return { kind: "replay", next };
  const allowed = transitions[current];
  if (allowed.includes(next)) return { kind: "applied", next };
  return {
    kind: "rejected",
    reason: allowed.length === 0 ? "terminal" : "invalid_transition",
  };
}

export function idempotencyDisposition(
  existing: StoredIdempotency | null,
  requestDigest: string,
): IdempotencyDisposition {
  if (existing === null) return "new";
  return existing.requestDigest === requestDigest ? "replay" : "conflict";
}

export function authorityMatches(
  left: AuthorityTuple,
  right: AuthorityTuple,
): boolean {
  return left.bootGeneration === right.bootGeneration
    && left.bootId === right.bootId
    && left.fence === right.fence;
}

export function schedulerExpiryDisposition(
  state: CommandState,
  deadline: number,
  now: number,
): "wait" | "expire" | "leave" {
  if (state !== "pending") return "leave";
  return now < deadline ? "wait" : "expire";
}

export function canTargetCancelPrepared(
  state: CommandState,
  localEffectStarted: boolean,
  boundAuthority: AuthorityTuple | null,
  liveAuthority: AuthorityTuple,
): boolean {
  return state === "prepared"
    && !localEffectStarted
    && boundAuthority !== null
    && authorityMatches(boundAuthority, liveAuthority);
}
