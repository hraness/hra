import type { NpmProvenanceAttemptPolicy } from "./verify-npm-provenance";

export type NpmArtifactState = "absent" | "exact";

export type NpmPublicationTransition = Readonly<{
  action: "admit_existing" | "publish";
  attemptPolicy: NpmProvenanceAttemptPolicy;
}>;

const positiveInteger = /^[1-9][0-9]*$/u;

export function decideNpmPublicationTransition(input: Readonly<{
  currentArtifactState: NpmArtifactState;
  currentRunAttempt: string;
  currentRunId: string;
  preflightArtifactState: NpmArtifactState;
  preflightRunAttempt: string;
  preflightRunId: string;
}>): NpmPublicationTransition {
  if (
    !positiveInteger.test(input.currentRunId)
    || !positiveInteger.test(input.currentRunAttempt)
    || !positiveInteger.test(input.preflightRunId)
    || !positiveInteger.test(input.preflightRunAttempt)
    || input.preflightRunId !== input.currentRunId
    || BigInt(input.preflightRunAttempt) > BigInt(input.currentRunAttempt)
  ) throw new Error("npm publication preflight is not from this workflow run at or before the current attempt.");
  if (input.preflightArtifactState === "exact" && input.currentArtifactState === "absent") {
    throw new Error("The exact npm artifact disappeared after publication preflight.");
  }
  if (input.currentArtifactState === "absent") {
    return Object.freeze({ action: "publish", attemptPolicy: "exact" });
  }
  const sameAttemptAbsent = input.preflightArtifactState === "absent"
    && input.preflightRunAttempt === input.currentRunAttempt;
  return Object.freeze({
    action: "admit_existing",
    attemptPolicy: sameAttemptAbsent ? "exact" : "same_run_not_later",
  });
}
