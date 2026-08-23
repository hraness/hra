export const authOtpLifetimeMs = 10 * 60 * 1_000;
export const maximumLiveOtpChallenges = 3;
export const authDigestPattern = /^[0-9a-f]{64}$/u;

export const authAttemptPolicies = {
  send: {
    global: [
      { limit: 30, windowMs: 60 * 60 * 1_000 },
      { limit: 50, windowMs: 24 * 60 * 60 * 1_000 },
    ],
    perEmail: [{ limit: 3, windowMs: 15 * 60 * 1_000 }],
    retentionMs: 24 * 60 * 60 * 1_000,
  },
  verify: {
    global: [{ limit: 100, windowMs: 60 * 60 * 1_000 }],
    perEmail: [{ limit: 10, windowMs: 15 * 60 * 1_000 }],
    retentionMs: 60 * 60 * 1_000,
  },
} as const;

export type AuthAttemptKind = keyof typeof authAttemptPolicies;

export type AuthAttemptEvent = Readonly<{
  createdAt: number;
  emailDigest: string;
  kind: AuthAttemptKind;
}>;

export function isAuthDigest(value: unknown): value is string {
  return typeof value === "string" && authDigestPattern.test(value);
}

export function wouldExceedAuthAttemptQuota(
  events: readonly AuthAttemptEvent[],
  candidate: Readonly<{
    emailDigest: string;
    kind: AuthAttemptKind;
    now: number;
  }>,
): boolean {
  const policy = authAttemptPolicies[candidate.kind];
  for (const window of policy.perEmail) {
    const cutoff = candidate.now - window.windowMs;
    const count = events.filter((event) =>
      event.kind === candidate.kind
      && event.emailDigest === candidate.emailDigest
      && event.createdAt >= cutoff
      && event.createdAt <= candidate.now).length;
    if (count >= window.limit) return true;
  }
  for (const window of policy.global) {
    const cutoff = candidate.now - window.windowMs;
    const count = events.filter((event) =>
      event.kind === candidate.kind
      && event.createdAt >= cutoff
      && event.createdAt <= candidate.now).length;
    if (count >= window.limit) return true;
  }
  return false;
}
