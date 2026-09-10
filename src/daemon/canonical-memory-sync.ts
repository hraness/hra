import type {
  CanonicalMemoryHostedAttachmentRecord,
  ProjectMemoryHeadRef,
} from "../storage/state-store.ts";
import type { ProjectId } from "../domain/values.ts";

export type CanonicalMemorySyncReason =
  | "after_canonical_mutation"
  | "background"
  | "before_canonical_mutation"
  | "owner"
  | "recovery";

export type CanonicalMemorySyncResult = Readonly<{
  attached: boolean;
  complete: boolean;
  localHead: ProjectMemoryHeadRef | null;
  operations: number;
  projectId: ProjectId;
  remoteHead: ProjectMemoryHeadRef | null;
  state: "converged" | "detached" | "incomplete";
}>;

export type CanonicalMemoryHostedSpace = Readonly<{
  attachedProjectId: ProjectId | null;
  canonicalSpaceId: string;
  hostedSpaceId: string;
  keyVersion: number;
  revision: number;
}>;

/**
 * Deliberately redacted owner-facing create result. The durable journal keeps
 * encrypted configuration needed for exact replay, but neither it nor this
 * boundary exposes the plaintext space key.
 */
export type CanonicalMemoryHostedCreateResult = Readonly<{
  attachment: CanonicalMemoryHostedAttachmentRecord;
  canonicalSpaceId: string;
  hostedSpaceId: string;
  projectId: ProjectId;
  replay: boolean;
}>;

/**
 * Daemon-owned hosted-memory seam. Cloud implements transport and encryption;
 * the memory coordinator consumes only this project-scoped capability.
 */
export interface OompaCanonicalMemorySyncPort {
  createHostedSpace(input: Readonly<{
    idempotencyKey: string;
    projectId: string;
  }>): Promise<CanonicalMemoryHostedCreateResult>;
  synchronizeProject(input: Readonly<{
    projectId: string;
    reason: CanonicalMemorySyncReason;
  }>): Promise<CanonicalMemorySyncResult>;
  scheduleProject(input: Readonly<{
    projectId: string;
    reason: Exclude<CanonicalMemorySyncReason, "before_canonical_mutation" | "owner">;
  }>): void;
  listHostedSpaces(): Promise<readonly CanonicalMemoryHostedSpace[]>;
  attachHostedSpace(input: Readonly<{
    hostedSpaceId: string;
    projectId: string;
  }>): Promise<CanonicalMemoryHostedAttachmentRecord>;
  detachHostedSpace(input: Readonly<{
    expectedGeneration: number;
    projectId: string;
  }>): Promise<CanonicalMemoryHostedAttachmentRecord>;
  /**
   * Starts the lifecycle-owned hosted recovery and reconciliation supervisor.
   * The first network attempt is deliberately not part of daemon readiness.
   */
  startBackgroundRecovery(): void;
  recover(): Promise<void>;
  close(): Promise<void>;
}
