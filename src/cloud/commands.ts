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

export type CommandAuthorityTransitionDisposition =
  | Readonly<{
      boundAuthority: AuthorityTuple;
      kind: "applied" | "rebound" | "replay";
      state: CommandState;
    }>
  | Readonly<{
      boundAuthority: AuthorityTuple | null;
      kind: "rejected";
      reason:
        | "bound_authority"
        | "invalid_transition"
        | "lease_not_live"
        | "live_authority";
      state: CommandState;
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

/**
 * Pure admission policy for effect-bearing target command transitions.
 *
 * The caller supplies the authority tuple and deadline read from the actual
 * execution lease. Rejections explicitly return the unchanged command
 * projection so model campaigns can assert that no state or binding moved.
 * Terminal receipt replay is intentionally outside this policy because it
 * reconciles an already-recorded result without attempting another effect.
 */
export function commandAuthorityTransitionDisposition(input: Readonly<{
  boundAuthority: AuthorityTuple | null;
  leaseUntil: number;
  liveAuthority: AuthorityTuple;
  next: "prepared" | "effect_started" | "applied" | "failed" | "ambiguous";
  now: number;
  requestedAuthority: AuthorityTuple;
  state: CommandState;
}>): CommandAuthorityTransitionDisposition {
  const rejected = (
    reason: Extract<CommandAuthorityTransitionDisposition, { kind: "rejected" }>["reason"],
  ): CommandAuthorityTransitionDisposition => ({
    boundAuthority: input.boundAuthority,
    kind: "rejected",
    reason,
    state: input.state,
  });

  if (
    !Number.isFinite(input.now)
    || !Number.isFinite(input.leaseUntil)
    || input.now < 0
    || input.leaseUntil <= input.now
  ) return rejected("lease_not_live");
  if (!authorityMatches(input.requestedAuthority, input.liveAuthority)) {
    return rejected("live_authority");
  }

  if (input.next === "prepared") {
    if (input.state === "pending") {
      if (input.boundAuthority !== null) return rejected("bound_authority");
      return {
        boundAuthority: input.requestedAuthority,
        kind: "applied",
        state: "prepared",
      };
    }
    if (input.state !== "prepared") return rejected("invalid_transition");
    if (input.boundAuthority === null) return rejected("bound_authority");
    if (authorityMatches(input.boundAuthority, input.requestedAuthority)) {
      return {
        boundAuthority: input.boundAuthority,
        kind: "replay",
        state: "prepared",
      };
    }
    return {
      boundAuthority: input.requestedAuthority,
      kind: "rebound",
      state: "prepared",
    };
  }

  if (
    input.boundAuthority === null
    || !authorityMatches(input.boundAuthority, input.requestedAuthority)
  ) return rejected("bound_authority");
  const transition = commandTransitionDisposition(input.state, input.next);
  if (transition.kind === "rejected") return rejected("invalid_transition");
  return {
    boundAuthority: input.boundAuthority,
    kind: transition.kind,
    state: transition.next,
  };
}
