import {
  type BoundedProcessContainmentUnavailableError,
  isBoundedProcessContainmentUnavailableError,
} from "./bounded-process";

export const isAuthorityContainmentUnavailable = (
  error: unknown,
): error is BoundedProcessContainmentUnavailableError =>
  isBoundedProcessContainmentUnavailableError(error);

/**
 * The only operator-facing representation of a provider command that did not
 * start because its required containment backend is unavailable. Keep this
 * separate from recovery-required process-cleanup failures: no target ran.
 */
export const renderAuthorityContainmentUnavailable = (error: unknown): string | undefined => {
  if (!isAuthorityContainmentUnavailable(error)) return undefined;
  return `${JSON.stringify({
    code: "authority_containment_unavailable",
    reason: error.reason,
    schemaVersion: 1,
    status: "refused",
  })}\n`;
};

/** Preserve an authority pre-execution refusal through reconciler catch paths. */
export const rethrowAuthorityContainmentUnavailable = (error: unknown): void => {
  if (isAuthorityContainmentUnavailable(error)) throw error;
};
