import { createHmac, randomBytes } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

import { z } from "@hra-internal/schema";

import { accountProfileIdSchema } from "../../../contracts/runtime";

const defaultEnsureTimeoutMs = 5_000;
const defaultDeleteTimeoutMs = 5 * 60_000;
const maximumTimeoutMs = 10 * 60_000;
const deletionKeyBytes = 32;

export interface AccountProfileFileSystemAuthority {
  readonly controlPlanePath: string;
  readonly stateRoot: Readonly<{
    readonly device: string;
    readonly inode: string;
  }>;
  readonly controlPlane: Readonly<{
    readonly device: string;
    readonly inode: string;
  }>;
}

export interface AccountProfileFileSystem {
  ensureAccountProfile(accountProfileId: string): Promise<void>;
  deleteAccountHome(
    accountProfileId: string,
    expectedRevision: number,
  ): Promise<void>;
}

export type AccountProfileFileSystemFailureReason =
  | "invalid_configuration"
  | "native_rejected"
  | "timeout"
  | "transport_failed";

const failureMessages = {
  invalid_configuration: "The account-profile filesystem authority is invalid.",
  native_rejected: "The native account-profile operation was rejected.",
  timeout: "The native account-profile operation exceeded its deadline.",
  transport_failed: "The native account-profile transport failed.",
} as const satisfies Record<AccountProfileFileSystemFailureReason, string>;

/**
 * These errors deliberately retain no path, account ID, nonce, native
 * response, or helper output.
 */
export class AccountProfileFileSystemError extends Error {
  readonly reason: AccountProfileFileSystemFailureReason;

  constructor(reason: AccountProfileFileSystemFailureReason) {
    super(failureMessages[reason]);
    this.name = "AccountProfileFileSystemError";
    this.reason = reason;
  }
}

export type NativeAccountProfileAction = "delete" | "ensure";

export interface NativeAccountProfileRequestEnvelope {
  readonly kind: "accountProfileNativeRequest";
  readonly version: 1;
  readonly request: Readonly<{
    readonly id: string;
    readonly binding: string;
    readonly action: NativeAccountProfileAction;
    readonly controlPlanePath: string;
    readonly accountProfileId: string;
    readonly stateRootDevice: string;
    readonly stateRootInode: string;
    readonly controlPlaneDevice: string;
    readonly controlPlaneInode: string;
    readonly deletionNonce?: string;
    readonly expectedRevision?: number;
  }>;
}

export const nativeAccountProfileResultSchema = z.object({
  kind: z.literal("accountProfileNativeResult"),
  version: z.literal(1),
  nativeRequestId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/u),
  binding: z.string().regex(/^binding_[a-f0-9]{48}$/u),
  action: z.enum(["delete", "ensure"]),
  accountProfileId: accountProfileIdSchema,
  ok: z.boolean(),
}).strict();

export type NativeAccountProfileResult = z.infer<
  typeof nativeAccountProfileResultSchema
>;

export type NativeAccountProfileRequestWriter = (
  request: NativeAccountProfileRequestEnvelope,
) => Promise<void>;

export interface NativeAccountProfileFileSystemOptions {
  readonly authority: AccountProfileFileSystemAuthority;
  readonly deletionKey: Uint8Array;
  readonly timeoutMs?: number;
  readonly ensureTimeoutMs?: number;
  readonly deleteTimeoutMs?: number;
  readonly writeRequest: NativeAccountProfileRequestWriter;
}

interface PendingNativeOperation {
  readonly accountProfileId: string;
  readonly action: NativeAccountProfileAction;
  readonly binding: string;
  readonly reject: (error: AccountProfileFileSystemError) => void;
  readonly resolve: () => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Sends private, path-bearing operations over the existing gateway stdio
 * channel to RuntimeHost. RuntimeHost alone resolves and attests the embedded
 * helper; the compiled gateway never executes a mutable helper pathname.
 */
export class NativeAccountProfileFileSystem implements AccountProfileFileSystem {
  readonly #authority: AccountProfileFileSystemAuthority;
  readonly #deletionKey: Uint8Array;
  readonly #pending = new Map<string, PendingNativeOperation>();
  readonly #ensureTimeoutMs: number;
  readonly #deleteTimeoutMs: number;
  readonly #writeRequest: NativeAccountProfileRequestWriter;
  #operationTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: NativeAccountProfileFileSystemOptions) {
    this.#authority = parseAuthority(options.authority);
    if (
      !(options.deletionKey instanceof Uint8Array)
      || options.deletionKey.byteLength !== deletionKeyBytes
    ) {
      throw new AccountProfileFileSystemError("invalid_configuration");
    }
    this.#deletionKey = Uint8Array.from(options.deletionKey);
    this.#ensureTimeoutMs = boundedDuration(
      options.ensureTimeoutMs ?? options.timeoutMs ?? defaultEnsureTimeoutMs,
    );
    this.#deleteTimeoutMs = boundedDuration(
      options.deleteTimeoutMs ?? options.timeoutMs ?? defaultDeleteTimeoutMs,
    );
    this.#writeRequest = options.writeRequest;
  }

  ensureAccountProfile(accountProfileId: string): Promise<void> {
    return this.#enqueue(() => this.#request("ensure", accountProfileId));
  }

  deleteAccountHome(
    accountProfileId: string,
    expectedRevision: number,
  ): Promise<void> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return Promise.reject(
        new AccountProfileFileSystemError("invalid_configuration"),
      );
    }
    return this.#enqueue(() =>
      this.#request(
        "delete",
        accountProfileId,
        deletionNonce(
          this.#deletionKey,
          this.#authority,
          accountProfileId,
          expectedRevision,
        ),
        expectedRevision,
      ),
    );
  }

  complete(value: unknown): boolean {
    const parsed = nativeAccountProfileResultSchema.safeParse(value);
    if (!parsed.success) return false;
    const result = parsed.data;
    const pending = this.#pending.get(result.nativeRequestId);
    if (
      pending === undefined
      || pending.binding !== result.binding
      || pending.action !== result.action
      || pending.accountProfileId !== result.accountProfileId
    ) {
      return false;
    }
    this.#pending.delete(result.nativeRequestId);
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve();
    else pending.reject(new AccountProfileFileSystemError("native_rejected"));
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AccountProfileFileSystemError("transport_failed"));
    }
    this.#pending.clear();
    this.#deletionKey.fill(0);
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.#operationTail.then(operation);
    this.#operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #request(
    action: NativeAccountProfileAction,
    rawAccountProfileId: string,
    deletionNonceValue?: string,
    expectedRevision?: number,
  ): Promise<void> {
    if (this.#closed) {
      throw new AccountProfileFileSystemError("transport_failed");
    }
    const parsedAccountProfileId =
      accountProfileIdSchema.safeParse(rawAccountProfileId);
    if (!parsedAccountProfileId.success) {
      throw new AccountProfileFileSystemError("invalid_configuration");
    }
    const accountProfileId = parsedAccountProfileId.data;
    if (
      (deletionNonceValue === undefined) !==
        (expectedRevision === undefined)
    ) {
      throw new AccountProfileFileSystemError("invalid_configuration");
    }
    const id = `native-profile-${randomBytes(12).toString("hex")}`;
    const binding = `binding_${randomBytes(24).toString("hex")}`;
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.#pending.delete(id)) return;
        reject(new AccountProfileFileSystemError("timeout"));
      }, action === "ensure" ? this.#ensureTimeoutMs : this.#deleteTimeoutMs);
      this.#pending.set(id, {
        accountProfileId,
        action,
        binding,
        reject,
        resolve,
        timer,
      });
    });
    const request: NativeAccountProfileRequestEnvelope = {
      kind: "accountProfileNativeRequest",
      version: 1,
      request: {
        id,
        binding,
        action,
        controlPlanePath: this.#authority.controlPlanePath,
        accountProfileId,
        stateRootDevice: this.#authority.stateRoot.device,
        stateRootInode: this.#authority.stateRoot.inode,
        controlPlaneDevice: this.#authority.controlPlane.device,
        controlPlaneInode: this.#authority.controlPlane.inode,
        ...(deletionNonceValue === undefined || expectedRevision === undefined
          ? {}
          : { deletionNonce: deletionNonceValue, expectedRevision }),
      },
    };
    void Promise.resolve()
      .then(() => this.#writeRequest(request))
      .catch(() => {
        const pending = this.#pending.get(id);
        if (pending !== undefined) {
          this.#pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(
            new AccountProfileFileSystemError("transport_failed"),
          );
        }
      });
    return await result;
  }
}

function deletionNonce(
  key: Uint8Array,
  authority: AccountProfileFileSystemAuthority,
  accountProfileId: string,
  expectedRevision: number,
): string {
  const digest = createHmac("sha256", key)
    .update("hraness-kitchen-account-home-deletion-v1\0")
    .update(authority.controlPlanePath)
    .update("\0")
    .update(authority.stateRoot.device)
    .update("\0")
    .update(authority.stateRoot.inode)
    .update("\0")
    .update(authority.controlPlane.device)
    .update("\0")
    .update(authority.controlPlane.inode)
    .update("\0")
    .update(accountProfileId)
    .update("\0")
    .update(String(expectedRevision))
    .digest("hex");
  return `deletion_${digest}`;
}

function parseAuthority(
  authority: AccountProfileFileSystemAuthority,
): AccountProfileFileSystemAuthority {
  const controlPlanePath = normalizedAbsolutePath(
    authority.controlPlanePath,
  );
  return {
    controlPlanePath,
    stateRoot: {
      device: decimalIdentity(authority.stateRoot.device),
      inode: decimalIdentity(authority.stateRoot.inode),
    },
    controlPlane: {
      device: decimalIdentity(authority.controlPlane.device),
      inode: decimalIdentity(authority.controlPlane.inode),
    },
  };
}

function decimalIdentity(value: string): string {
  if (!/^[1-9][0-9]{0,19}$/u.test(value)) {
    throw new AccountProfileFileSystemError("invalid_configuration");
  }
  try {
    if (BigInt(value) > 18_446_744_073_709_551_615n) {
      throw new AccountProfileFileSystemError("invalid_configuration");
    }
  } catch {
    throw new AccountProfileFileSystemError("invalid_configuration");
  }
  return value;
}

function normalizedAbsolutePath(path: string): string {
  if (
    !isAbsolute(path)
    || path.length < 2
    || path.length > 4_096
    || normalize(path) !== path
    || path.includes("\0")
  ) {
    throw new AccountProfileFileSystemError("invalid_configuration");
  }
  return path;
}

function boundedDuration(value: number): number {
  if (
    !Number.isSafeInteger(value)
    || value < 1
    || value > maximumTimeoutMs
  ) {
    throw new AccountProfileFileSystemError("invalid_configuration");
  }
  return value;
}
