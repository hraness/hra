import {
  workspaceAuthoritySchema,
  workspacePublicIdSchema,
  type WorkspaceAuthority,
} from "@hraness/agent-tasks-protocol";
import { z } from "@hra-internal/schema";

export const workspaceRecoveryAuthoritySchema = z
  .object({
    kind: z.literal("recovery"),
    localWorkspaceId: workspacePublicIdSchema,
    cloudWorkspaceId: workspacePublicIdSchema.optional(),
    state: z.enum([
      "activation_outcome_unknown",
      "read_only_local_copy",
      "repair_required",
    ]),
  })
  .strict();

export type WorkspaceRecoveryAuthority = z.infer<
  typeof workspaceRecoveryAuthoritySchema
>;
export type RoutableWorkspaceAuthority =
  | WorkspaceAuthority
  | WorkspaceRecoveryAuthority;

export type WorkspaceAuthorityRoute<LocalAdapter, CloudAdapter> =
  | {
      readonly ok: true;
      readonly kind: "local";
      readonly adapter: LocalAdapter;
      readonly workspaceId: string;
    }
  | {
      readonly ok: true;
      readonly kind: "cloud";
      readonly adapter: CloudAdapter;
      readonly workspaceId: string;
    }
  | {
      readonly ok: false;
      readonly reason:
        | "activation_outcome_unknown"
        | "authority_mismatch"
        | "promotion_in_progress"
        | "recovery_read_only"
        | "repair_required";
    };

/**
 * Selects exactly one provider adapter. Transitional authority deliberately
 * returns no adapter, so callers cannot accidentally fall back to SQLite or
 * issue a cloud mutation while activation/recovery is unresolved.
 */
export class WorkspaceAuthorityRouter<LocalAdapter, CloudAdapter> {
  readonly #cloud: CloudAdapter;
  readonly #local: LocalAdapter;

  constructor(options: {
    readonly local: LocalAdapter;
    readonly cloud: CloudAdapter;
  }) {
    this.#local = options.local;
    this.#cloud = options.cloud;
  }

  route(
    workspaceIdValue: string,
    authorityValue: RoutableWorkspaceAuthority,
  ): WorkspaceAuthorityRoute<LocalAdapter, CloudAdapter> {
    const workspaceId = workspacePublicIdSchema.parse(workspaceIdValue);
    const recovery = workspaceRecoveryAuthoritySchema.safeParse(authorityValue);
    if (recovery.success) {
      if (recovery.data.localWorkspaceId !== workspaceId) {
        return { ok: false, reason: "authority_mismatch" };
      }
      return {
        ok: false,
        reason: recovery.data.state === "activation_outcome_unknown"
          ? "activation_outcome_unknown"
          : recovery.data.state === "repair_required"
            ? "repair_required"
            : "recovery_read_only",
      };
    }
    const authority = workspaceAuthoritySchema.parse(authorityValue);
    if (authority.kind === "local") {
      return authority.localWorkspaceId === workspaceId
        ? {
            ok: true,
            kind: "local",
            adapter: this.#local,
            workspaceId,
          }
        : { ok: false, reason: "authority_mismatch" };
    }
    if (authority.kind === "cloud") {
      return authority.cloudWorkspaceId === workspaceId
        ? {
            ok: true,
            kind: "cloud",
            adapter: this.#cloud,
            workspaceId,
          }
        : { ok: false, reason: "authority_mismatch" };
    }
    if (authority.localWorkspaceId !== workspaceId) {
      return { ok: false, reason: "authority_mismatch" };
    }
    return {
      ok: false,
      reason: authority.phase === "outcome_unknown"
        ? "activation_outcome_unknown"
        : "promotion_in_progress",
    };
  }
}
