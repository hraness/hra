import { query } from "./server";

/**
 * The tracked checkout is deliberately unbound. The checked deployment helper
 * overlays only this module in a clean `git archive` of the selected commit.
 * A normal or accidental deployment therefore cannot claim release authority.
 */
export const RELEASE_ATTESTATION = Object.freeze({
  bound: false as const,
  schemaIdentity: "hra-release-attestation-v1" as const,
  schemaVersion: 1 as const,
});

export const read = query({
  args: {},
  handler: () => RELEASE_ATTESTATION,
});
