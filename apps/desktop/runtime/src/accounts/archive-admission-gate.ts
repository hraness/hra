import { accountProfileIdSchema, type AccountSummary } from "../../../contracts/runtime";

export type ArchiveAdmissionAccountProfileId = AccountSummary["id"];
export type ArchiveAdmissionPurpose = "pane_archive" | "start_fresh";
export type ArchiveAdmissionAttemptPhase =
  | "abandoned_pre_effect"
  | "account_contained"
  | "ambiguous"
  | "direct_applied"
  | "effect_started"
  | "prepared"
  | "reconciled_applied"
  | "reconciled_not_applied";

export interface ArchiveAdmissionAuthority {
  readonly hmac: string;
  readonly revision: number;
}

export interface ArchiveAdmissionProvisionalDescriptor {
  readonly accountProfileId: ArchiveAdmissionAccountProfileId;
  readonly paneId: string;
  readonly purpose: ArchiveAdmissionPurpose;
  readonly transitionId: string;
}

export interface ArchiveAdmissionDescriptor
  extends ArchiveAdmissionProvisionalDescriptor {
  readonly attemptAuthority: ArchiveAdmissionAuthority;
  readonly attemptOrdinal: number;
  readonly attemptPhase: ArchiveAdmissionAttemptPhase;
  readonly cutAuthority: ArchiveAdmissionAuthority | null;
  readonly expectedGeneration: number;
  readonly restartThreadDigest: string;
  /** Exact journal-authorized runtime for post-cut reconciliation. */
  readonly successorGeneration: number | null;
  readonly targetAuthority: ArchiveAdmissionAuthority;
}

export interface AccountRemovalAdmissionProvisionalDescriptor {
  readonly accountProfileId: ArchiveAdmissionAccountProfileId;
  readonly expectedGeneration: number;
  readonly transitionId: string;
}

export interface AccountRemovalAdmissionDescriptor
  extends AccountRemovalAdmissionProvisionalDescriptor {
  readonly cutAuthority: ArchiveAdmissionAuthority;
}

declare const archiveAdmissionHandleBrand: unique symbol;
declare const archiveAdmissionProvisionalHandleBrand: unique symbol;
declare const accountRemovalAdmissionHandleBrand: unique symbol;
declare const accountRemovalAdmissionProvisionalHandleBrand: unique symbol;
declare const archiveAdmissionEffectClaimBrand: unique symbol;

/** Exact durable provider-thread archive authority. */
export type ArchiveAdmissionHandle = Readonly<{
  readonly [archiveAdmissionHandleBrand]: true;
}>;

/** Pre-journal hold. It has no provider RPC authority. */
export type ArchiveAdmissionProvisionalHandle = Readonly<{
  readonly [archiveAdmissionProvisionalHandleBrand]: true;
}>;

/** Targetless account-removal root authority. It has no archive RPC authority. */
export type AccountRemovalAdmissionHandle = Readonly<{
  readonly [accountRemovalAdmissionHandleBrand]: true;
}>;

/** Pre-cut account-removal root hold. It has no fence or RPC authority. */
export type AccountRemovalAdmissionProvisionalHandle = Readonly<{
  readonly [accountRemovalAdmissionProvisionalHandleBrand]: true;
}>;

/** One same-process claim for the exact effect-started archive mutation. */
export type ArchiveAdmissionEffectClaim = Readonly<{
  readonly [archiveAdmissionEffectClaimBrand]: true;
}>;

export type ArchiveAdmissionListener = (held: boolean) => void;

type AdmissionHandle =
  | AccountRemovalAdmissionHandle
  | AccountRemovalAdmissionProvisionalHandle
  | ArchiveAdmissionHandle
  | ArchiveAdmissionProvisionalHandle;

type AdmissionRecord =
  | ExactAdmissionRecord
  | ProvisionalAdmissionRecord
  | RemovalProvisionalAdmissionRecord
  | RemovalAdmissionRecord;

interface AdmissionRecordBase {
  active: boolean;
  readonly accountProfileId: ArchiveAdmissionAccountProfileId;
  readonly fingerprint: string;
  readonly handle: AdmissionHandle;
  readonly lineageKey: string;
}

interface ExactAdmissionRecord extends AdmissionRecordBase {
  readonly descriptor: ArchiveAdmissionDescriptor;
  effectClaimed: boolean;
  readonly effectEligible: boolean;
  readonly handle: ArchiveAdmissionHandle;
  readonly kind: "exact";
  readonly liveLineage: boolean;
}

interface EffectClaimRecord {
  begun: boolean;
  readonly claim: ArchiveAdmissionEffectClaim;
  readonly admission: ExactAdmissionRecord;
}

interface ProvisionalAdmissionRecord extends AdmissionRecordBase {
  readonly descriptor: ArchiveAdmissionProvisionalDescriptor;
  readonly handle: ArchiveAdmissionProvisionalHandle;
  readonly kind: "provisional";
}

interface RemovalAdmissionRecord extends AdmissionRecordBase {
  readonly descriptor: AccountRemovalAdmissionDescriptor;
  readonly handle: AccountRemovalAdmissionHandle;
  readonly kind: "account_removal";
}

interface RemovalProvisionalAdmissionRecord extends AdmissionRecordBase {
  readonly descriptor: AccountRemovalAdmissionProvisionalDescriptor;
  readonly handle: AccountRemovalAdmissionProvisionalHandle;
  readonly kind: "account_removal_provisional";
}

const sha256Pattern = /^[0-9a-f]{64}$/u;
const maximumOpaqueIdentityLength = 512;

export class ArchiveAdmissionHeldError extends Error {
  constructor() {
    super("The account runtime is quarantined for provider archive recovery.");
    this.name = "ArchiveAdmissionHeldError";
  }
}

export class ArchiveAdmissionAuthorityError extends Error {
  constructor(message = "The provider archive admission authority is invalid or stale.") {
    super(message);
    this.name = "ArchiveAdmissionAuthorityError";
  }
}

/**
 * Account-wide in-memory quarantine for durable provider transitions. Durable
 * state recreates holds after restart; this gate never persists or serializes
 * handles. Exact object identity in the private WeakMap is the handle proof.
 */
export class ArchiveAdmissionGate {
  readonly #byAccount = new Map<
    ArchiveAdmissionAccountProfileId,
    Set<AdmissionRecord>
  >();
  readonly #byFingerprint = new Map<string, AdmissionRecord>();
  readonly #byHandle = new WeakMap<object, AdmissionRecord>();
  readonly #effectClaims = new WeakMap<object, EffectClaimRecord>();
  readonly #byLineage = new Map<string, AdmissionRecord>();
  readonly #listeners = new Map<
    ArchiveAdmissionAccountProfileId,
    Set<ArchiveAdmissionListener>
  >();

  retainProvisional(
    input: ArchiveAdmissionProvisionalDescriptor,
  ): ArchiveAdmissionProvisionalHandle {
    const descriptor = provisionalDescriptor(input);
    const fingerprint = `provisional:${JSON.stringify(descriptor)}`;
    const exact = this.#byFingerprint.get(fingerprint);
    if (exact?.kind === "provisional" && exact.active) return exact.handle;
    const lineageKey = archiveLineageKey(descriptor);
    this.#assertLineageVacant(lineageKey);
    const wasHeld = this.isHeld(descriptor.accountProfileId);
    const handle = createHandle<ArchiveAdmissionProvisionalHandle>();
    const record: ProvisionalAdmissionRecord = {
      accountProfileId: descriptor.accountProfileId,
      active: true,
      descriptor,
      fingerprint,
      handle,
      kind: "provisional",
      lineageKey,
    };
    this.#install(record);
    if (!wasHeld) this.#publish(descriptor.accountProfileId, true);
    return handle;
  }

  promote(
    provisionalHandle: ArchiveAdmissionProvisionalHandle,
    input: ArchiveAdmissionDescriptor,
  ): ArchiveAdmissionHandle {
    const provisional = this.#requireKind(provisionalHandle, "provisional");
    const descriptor = exactDescriptor(input);
    const lineageKey = archiveLineageKey(descriptor);
    if (lineageKey !== provisional.lineageKey) {
      throw new ArchiveAdmissionAuthorityError(
        "A provisional archive hold can promote only its exact transition target.",
      );
    }
    if (descriptor.attemptPhase !== "prepared") {
      throw new ArchiveAdmissionAuthorityError(
        "A provisional archive hold can promote only a prepared durable attempt.",
      );
    }
    const successor = this.#newExactRecord(descriptor, lineageKey, true, false);
    this.#install(successor);
    this.#byLineage.set(lineageKey, successor);
    this.#retire(provisional);
    return successor.handle;
  }

  /**
   * Promotes one provisional hold after the caller atomically persisted both
   * the target and its effect-started attempt. This is the only path that may
   * grant mutation authority without exposing a crash-visible prepared row.
   */
  promoteEffectStarted(
    provisionalHandle: ArchiveAdmissionProvisionalHandle,
    input: ArchiveAdmissionDescriptor,
  ): ArchiveAdmissionHandle {
    const provisional = this.#requireKind(provisionalHandle, "provisional");
    const descriptor = exactDescriptor(input);
    const lineageKey = archiveLineageKey(descriptor);
    if (lineageKey !== provisional.lineageKey) {
      throw new ArchiveAdmissionAuthorityError(
        "A provisional archive hold can promote only its exact transition target.",
      );
    }
    if (
      descriptor.attemptPhase !== "effect_started" ||
      descriptor.cutAuthority !== null ||
      descriptor.successorGeneration !== null
    ) {
      throw new ArchiveAdmissionAuthorityError(
        "A provisional archive mutation requires one unfenced effect-started attempt.",
      );
    }
    const successor = this.#newExactRecord(descriptor, lineageKey, true, true);
    this.#install(successor);
    this.#byLineage.set(lineageKey, successor);
    this.#retire(provisional);
    return successor.handle;
  }

  abortProvisional(handle: ArchiveAdmissionProvisionalHandle): void {
    const record = this.#requireKind(handle, "provisional");
    this.#releaseCurrent(record);
  }

  retain(input: ArchiveAdmissionDescriptor): ArchiveAdmissionHandle {
    const descriptor = exactDescriptor(input);
    const fingerprint = exactFingerprint(descriptor);
    const exact = this.#byFingerprint.get(fingerprint);
    if (exact?.kind === "exact" && exact.active) return exact.handle;
    const lineageKey = archiveLineageKey(descriptor);
    this.#assertLineageVacant(lineageKey);
    const wasHeld = this.isHeld(descriptor.accountProfileId);
    const record = this.#newExactRecord(descriptor, lineageKey, false, false);
    this.#install(record);
    if (!wasHeld) this.#publish(descriptor.accountProfileId, true);
    return record.handle;
  }

  /**
   * Converts one replayed, durably contained not-applied attempt into a live
   * same-process successor lineage. This grants no provider mutation authority
   * by itself. The exact successor attempt must still be persisted as
   * effect-started and installed through replace() before a one-shot mutation
   * claim can exist.
   */
  activateContainedSuccessor(
    handle: ArchiveAdmissionHandle,
  ): ArchiveAdmissionHandle {
    const current = this.#requireKind(handle, "exact");
    this.#assertNoRemovalHold(current.accountProfileId);
    if (
      current.descriptor.attemptPhase !== "reconciled_not_applied" ||
      current.descriptor.cutAuthority === null ||
      current.descriptor.successorGeneration === null
    ) {
      throw new ArchiveAdmissionAuthorityError(
        "Only an exact contained not-applied attempt can activate its successor lineage.",
      );
    }
    if (current.liveLineage) return current.handle;

    // Install the same durable authority first, then retire its replay-only
    // handle. The account remains held throughout and the returned handle has
    // no effect claim until an exact successor effect-started descriptor lands.
    const successor = this.#newExactRecord(
      current.descriptor,
      current.lineageKey,
      true,
      false,
    );
    this.#install(successor);
    this.#byLineage.set(current.lineageKey, successor);
    this.#retire(current);
    return successor.handle;
  }

  replace(
    predecessor: ArchiveAdmissionHandle,
    input: ArchiveAdmissionDescriptor,
  ): ArchiveAdmissionHandle {
    const current = this.#requireKind(predecessor, "exact");
    const descriptor = exactDescriptor(input);
    const fingerprint = exactFingerprint(descriptor);
    if (fingerprint === current.fingerprint) return current.handle;
    const lineageKey = archiveLineageKey(descriptor);
    if (lineageKey !== current.lineageKey || !advancesDescriptor(current.descriptor, descriptor)) {
      throw new ArchiveAdmissionAuthorityError(
        "A provider archive admission replacement must monotonically advance the same recovery lineage.",
      );
    }
    const conflictingExact = this.#byFingerprint.get(fingerprint);
    if (conflictingExact !== undefined && conflictingExact.active) {
      throw new ArchiveAdmissionAuthorityError(
        "The replacement provider archive admission authority is already active.",
      );
    }

    // Install and select the successor first. The deliberate overlap prevents
    // an ordinary-admission gap across journal-authority replacement.
    const effectEligible = current.liveLineage &&
      descriptor.attemptPhase === "effect_started" &&
      (
        current.descriptor.attemptPhase === "prepared" ||
        current.descriptor.attemptPhase === "reconciled_not_applied"
      );
    const successor = this.#newExactRecord(
      descriptor,
      lineageKey,
      current.liveLineage,
      effectEligible,
    );
    this.#install(successor);
    this.#byLineage.set(lineageKey, successor);
    this.#retire(current);
    return successor.handle;
  }

  release(handle: ArchiveAdmissionHandle): void {
    this.#releaseCurrent(this.#requireKind(handle, "exact"));
  }

  require(
    handle: ArchiveAdmissionHandle,
    accountProfileId?: ArchiveAdmissionAccountProfileId,
  ): ArchiveAdmissionDescriptor {
    const record = this.#requireKind(handle, "exact");
    this.#assertAccount(record, accountProfileId);
    this.#assertNoRemovalHold(record.accountProfileId);
    return record.descriptor;
  }

  claimThreadArchiveEffect(
    handle: ArchiveAdmissionHandle,
  ): ArchiveAdmissionEffectClaim {
    const record = this.#requireKind(handle, "exact");
    this.#assertNoRemovalHold(record.accountProfileId);
    if (
      !record.effectEligible || record.effectClaimed ||
      record.descriptor.attemptPhase !== "effect_started" ||
      record.descriptor.cutAuthority !== null
    ) {
      throw new ArchiveAdmissionAuthorityError(
        "This archive handle has no same-process mutation authority.",
      );
    }
    const claim = createHandle<ArchiveAdmissionEffectClaim>();
    const claimRecord: EffectClaimRecord = {
      admission: record,
      begun: false,
      claim,
    };
    record.effectClaimed = true;
    this.#effectClaims.set(claim, claimRecord);
    return claim;
  }

  requireThreadArchiveEffectClaim(
    claim: ArchiveAdmissionEffectClaim,
  ): ArchiveAdmissionDescriptor {
    const claimRecord = this.#requireEffectClaim(claim);
    return this.require(claimRecord.admission.handle);
  }

  beginThreadArchiveEffect(claim: ArchiveAdmissionEffectClaim): void {
    const claimRecord = this.#requireEffectClaim(claim);
    this.require(claimRecord.admission.handle);
    if (claimRecord.begun) {
      throw new ArchiveAdmissionAuthorityError(
        "The archive mutation authority was already consumed.",
      );
    }
    claimRecord.begun = true;
  }

  abortThreadArchiveEffectClaim(claim: ArchiveAdmissionEffectClaim): void {
    const claimRecord = this.#requireEffectClaim(claim);
    if (claimRecord.begun) {
      throw new ArchiveAdmissionAuthorityError(
        "A begun archive mutation authority cannot be retried.",
      );
    }
    this.#effectClaims.delete(claim);
    if (claimRecord.admission.active) {
      claimRecord.admission.effectClaimed = false;
    }
  }

  retainAccountRemovalProvisional(
    input: AccountRemovalAdmissionProvisionalDescriptor,
  ): AccountRemovalAdmissionProvisionalHandle {
    const descriptor = removalProvisionalDescriptor(input);
    const fingerprint = `account-removal-provisional:${JSON.stringify(descriptor)}`;
    const exact = this.#byFingerprint.get(fingerprint);
    if (exact?.kind === "account_removal_provisional" && exact.active) {
      return exact.handle;
    }
    const lineageKey = removalLineageKey(descriptor);
    this.#assertLineageVacant(lineageKey);
    const wasHeld = this.isHeld(descriptor.accountProfileId);
    const handle = createHandle<AccountRemovalAdmissionProvisionalHandle>();
    const record: RemovalProvisionalAdmissionRecord = {
      accountProfileId: descriptor.accountProfileId,
      active: true,
      descriptor,
      fingerprint,
      handle,
      kind: "account_removal_provisional",
      lineageKey,
    };
    this.#install(record);
    if (!wasHeld) this.#publish(descriptor.accountProfileId, true);
    return handle;
  }

  promoteAccountRemoval(
    provisionalHandle: AccountRemovalAdmissionProvisionalHandle,
    input: AccountRemovalAdmissionDescriptor,
  ): AccountRemovalAdmissionHandle {
    const provisional = this.#requireKind(
      provisionalHandle,
      "account_removal_provisional",
    );
    const descriptor = removalDescriptor(input);
    const lineageKey = removalLineageKey(descriptor);
    if (
      lineageKey !== provisional.lineageKey ||
      descriptor.expectedGeneration !== provisional.descriptor.expectedGeneration
    ) {
      throw new ArchiveAdmissionAuthorityError(
        "An account-removal provisional hold can promote only its exact source generation.",
      );
    }
    const successor = this.#newRemovalRecord(descriptor, lineageKey);
    this.#install(successor);
    this.#byLineage.set(lineageKey, successor);
    this.#retire(provisional);
    return successor.handle;
  }

  abortAccountRemovalProvisional(
    handle: AccountRemovalAdmissionProvisionalHandle,
  ): void {
    this.#releaseCurrent(this.#requireKind(
      handle,
      "account_removal_provisional",
    ));
  }

  retainAccountRemoval(
    input: AccountRemovalAdmissionDescriptor,
  ): AccountRemovalAdmissionHandle {
    const descriptor = removalDescriptor(input);
    const fingerprint = `account-removal:${JSON.stringify(descriptor)}`;
    const exact = this.#byFingerprint.get(fingerprint);
    if (exact?.kind === "account_removal" && exact.active) return exact.handle;
    const lineageKey = removalLineageKey(descriptor);
    this.#assertLineageVacant(lineageKey);
    const wasHeld = this.isHeld(descriptor.accountProfileId);
    const record = this.#newRemovalRecord(descriptor, lineageKey);
    this.#install(record);
    if (!wasHeld) this.#publish(descriptor.accountProfileId, true);
    return record.handle;
  }

  releaseAccountRemoval(handle: AccountRemovalAdmissionHandle): void {
    this.#releaseCurrent(this.#requireKind(handle, "account_removal"));
  }

  requireAccountRemoval(
    handle: AccountRemovalAdmissionHandle,
    accountProfileId?: ArchiveAdmissionAccountProfileId,
  ): AccountRemovalAdmissionDescriptor {
    const record = this.#requireKind(handle, "account_removal");
    this.#assertAccount(record, accountProfileId);
    return record.descriptor;
  }

  isHeld(accountProfileId: ArchiveAdmissionAccountProfileId): boolean {
    const parsed = accountProfileIdSchema.safeParse(accountProfileId);
    if (!parsed.success) return false;
    return (this.#byAccount.get(parsed.data)?.size ?? 0) > 0;
  }

  assertOrdinaryAdmission(accountProfileId: ArchiveAdmissionAccountProfileId): void {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    if (this.isHeld(profileId)) throw new ArchiveAdmissionHeldError();
  }

  subscribe(
    accountProfileId: ArchiveAdmissionAccountProfileId,
    listener: ArchiveAdmissionListener,
  ): () => void {
    const profileId = accountProfileIdSchema.parse(accountProfileId);
    let listeners = this.#listeners.get(profileId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#listeners.set(profileId, listeners);
    }
    listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      const current = this.#listeners.get(profileId);
      current?.delete(listener);
      if (current?.size === 0) this.#listeners.delete(profileId);
    };
  }

  #newExactRecord(
    descriptor: ArchiveAdmissionDescriptor,
    lineageKey: string,
    liveLineage: boolean,
    effectEligible: boolean,
  ): ExactAdmissionRecord {
    const handle = createHandle<ArchiveAdmissionHandle>();
    return {
      accountProfileId: descriptor.accountProfileId,
      active: true,
      descriptor,
      effectClaimed: false,
      effectEligible,
      fingerprint: exactFingerprint(descriptor),
      handle,
      kind: "exact",
      lineageKey,
      liveLineage,
    };
  }

  #newRemovalRecord(
    descriptor: AccountRemovalAdmissionDescriptor,
    lineageKey: string,
  ): RemovalAdmissionRecord {
    const handle = createHandle<AccountRemovalAdmissionHandle>();
    return {
      accountProfileId: descriptor.accountProfileId,
      active: true,
      descriptor,
      fingerprint: `account-removal:${JSON.stringify(descriptor)}`,
      handle,
      kind: "account_removal",
      lineageKey,
    };
  }

  #install(record: AdmissionRecord): void {
    let records = this.#byAccount.get(record.accountProfileId);
    if (records === undefined) {
      records = new Set();
      this.#byAccount.set(record.accountProfileId, records);
    }
    records.add(record);
    this.#byFingerprint.set(record.fingerprint, record);
    this.#byLineage.set(record.lineageKey, record);
    this.#byHandle.set(record.handle, record);
  }

  #retire(record: AdmissionRecord): void {
    if (!record.active) throw new ArchiveAdmissionAuthorityError();
    record.active = false;
    if (this.#byFingerprint.get(record.fingerprint) === record) {
      this.#byFingerprint.delete(record.fingerprint);
    }
    if (this.#byLineage.get(record.lineageKey) === record) {
      this.#byLineage.delete(record.lineageKey);
    }
    const records = this.#byAccount.get(record.accountProfileId);
    records?.delete(record);
    if (records?.size === 0) this.#byAccount.delete(record.accountProfileId);
  }

  #releaseCurrent(record: AdmissionRecord): void {
    if (this.#byLineage.get(record.lineageKey) !== record) {
      throw new ArchiveAdmissionAuthorityError(
        "A stale provider admission authority cannot release its successor.",
      );
    }
    const accountProfileId = record.accountProfileId;
    this.#retire(record);
    if (!this.isHeld(accountProfileId)) this.#publish(accountProfileId, false);
  }

  #requireRecord(handle: AdmissionHandle): AdmissionRecord {
    if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
      throw new ArchiveAdmissionAuthorityError();
    }
    const record = this.#byHandle.get(handle);
    if (record === undefined || !record.active) throw new ArchiveAdmissionAuthorityError();
    return record;
  }

  #requireEffectClaim(claim: ArchiveAdmissionEffectClaim): EffectClaimRecord {
    if ((typeof claim !== "object" && typeof claim !== "function") || claim === null) {
      throw new ArchiveAdmissionAuthorityError();
    }
    const record = this.#effectClaims.get(claim);
    if (record === undefined || !record.admission.active) {
      throw new ArchiveAdmissionAuthorityError();
    }
    return record;
  }

  #requireKind<K extends AdmissionRecord["kind"]>(
    handle: AdmissionHandle,
    kind: K,
  ): Extract<AdmissionRecord, Readonly<{ kind: K }>> {
    const record = this.#requireRecord(handle);
    if (record.kind !== kind) {
      throw new ArchiveAdmissionAuthorityError(
        "The provider admission handle has no authority for this operation.",
      );
    }
    return record as Extract<AdmissionRecord, Readonly<{ kind: K }>>;
  }

  #assertAccount(
    record: AdmissionRecord,
    accountProfileId: ArchiveAdmissionAccountProfileId | undefined,
  ): void {
    if (
      accountProfileId !== undefined &&
      record.accountProfileId !== accountProfileId
    ) {
      throw new ArchiveAdmissionAuthorityError(
        "The provider admission authority belongs to another account.",
      );
    }
  }

  #assertLineageVacant(lineageKey: string): void {
    if (this.#byLineage.get(lineageKey)?.active === true) {
      throw new ArchiveAdmissionAuthorityError(
        "A different provider admission authority already owns this transition.",
      );
    }
  }

  #assertNoRemovalHold(accountProfileId: ArchiveAdmissionAccountProfileId): void {
    const records = this.#byAccount.get(accountProfileId);
    if (
      records !== undefined && [...records].some((record) =>
        record.active && (
          record.kind === "account_removal" ||
          record.kind === "account_removal_provisional"
        )
      )
    ) {
      throw new ArchiveAdmissionAuthorityError(
        "Account removal dominates provider archive recovery.",
      );
    }
  }

  #publish(accountProfileId: ArchiveAdmissionAccountProfileId, held: boolean): void {
    const listeners = this.#listeners.get(accountProfileId);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        listener(held);
      } catch {
        // Admission state cannot be delegated to an observer.
      }
    }
  }
}

export function archiveRestartThreadDigest(threadId: string): string {
  validateOpaqueIdentity(threadId, "Provider restart thread identity");
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update("hra.chat.archive-restart-thread.v1\0");
  hasher.update(threadId);
  return hasher.digest("hex");
}

function provisionalDescriptor(
  input: ArchiveAdmissionProvisionalDescriptor,
): ArchiveAdmissionProvisionalDescriptor {
  const accountProfileId = accountProfileIdSchema.parse(input.accountProfileId);
  validateOpaqueIdentity(input.transitionId, "Provider archive transition identity");
  validateOpaqueIdentity(input.paneId, "Provider archive pane identity");
  validatePurpose(input.purpose);
  return Object.freeze({
    accountProfileId,
    paneId: input.paneId,
    purpose: input.purpose,
    transitionId: input.transitionId,
  });
}

function exactDescriptor(input: ArchiveAdmissionDescriptor): ArchiveAdmissionDescriptor {
  const provisional = provisionalDescriptor(input);
  if (!Number.isSafeInteger(input.attemptOrdinal) || input.attemptOrdinal < 1) {
    throw new ArchiveAdmissionAuthorityError(
      "The provider archive attempt ordinal must be a positive safe integer.",
    );
  }
  validateAttemptPhase(input.attemptPhase);
  validatePositiveGeneration(input.expectedGeneration, "attempt");
  if (!sha256Pattern.test(input.restartThreadDigest)) {
    throw new ArchiveAdmissionAuthorityError(
      "The provider restart thread digest is invalid.",
    );
  }
  if (input.cutAuthority === null && input.successorGeneration !== null) {
    throw new ArchiveAdmissionAuthorityError(
      "Provider archive successor-generation authority requires an installed cut.",
    );
  }
  if (input.successorGeneration !== null) {
    validatePositiveGeneration(input.successorGeneration, "successor");
    if (
      input.expectedGeneration === Number.MAX_SAFE_INTEGER ||
      input.successorGeneration !== input.expectedGeneration + 1
    ) {
      throw new ArchiveAdmissionAuthorityError(
        "The provider archive successor must be the exact next generation.",
      );
    }
  }
  return Object.freeze({
    ...provisional,
    attemptAuthority: admissionAuthority(input.attemptAuthority, "attempt"),
    attemptOrdinal: input.attemptOrdinal,
    attemptPhase: input.attemptPhase,
    cutAuthority: input.cutAuthority === null
      ? null
      : admissionAuthority(input.cutAuthority, "cut"),
    expectedGeneration: input.expectedGeneration,
    restartThreadDigest: input.restartThreadDigest,
    successorGeneration: input.successorGeneration,
    targetAuthority: admissionAuthority(input.targetAuthority, "target"),
  });
}

function removalDescriptor(
  input: AccountRemovalAdmissionDescriptor,
): AccountRemovalAdmissionDescriptor {
  const provisional = removalProvisionalDescriptor(input);
  return Object.freeze({
    ...provisional,
    cutAuthority: admissionAuthority(input.cutAuthority, "account-removal cut"),
  });
}

function removalProvisionalDescriptor(
  input: AccountRemovalAdmissionProvisionalDescriptor,
): AccountRemovalAdmissionProvisionalDescriptor {
  const accountProfileId = accountProfileIdSchema.parse(input.accountProfileId);
  validateOpaqueIdentity(input.transitionId, "Account-removal transition identity");
  validatePositiveGeneration(input.expectedGeneration, "account-removal source");
  return Object.freeze({
    accountProfileId,
    expectedGeneration: input.expectedGeneration,
    transitionId: input.transitionId,
  });
}

function admissionAuthority(
  input: ArchiveAdmissionAuthority,
  label: string,
): ArchiveAdmissionAuthority {
  if (
    typeof input !== "object" || input === null ||
    !sha256Pattern.test(input.hmac) ||
    !Number.isSafeInteger(input.revision) || input.revision < 1
  ) {
    throw new ArchiveAdmissionAuthorityError(
      `The provider archive ${label} authority is invalid.`,
    );
  }
  return Object.freeze({ hmac: input.hmac, revision: input.revision });
}

function advancesDescriptor(
  current: ArchiveAdmissionDescriptor,
  successor: ArchiveAdmissionDescriptor,
): boolean {
  const containedRebase =
    current.cutAuthority !== null &&
    current.successorGeneration !== null &&
    successor.cutAuthority === null &&
    successor.successorGeneration === null;
  if (current.restartThreadDigest !== successor.restartThreadDigest) return false;
  if (containedRebase) {
    return current.attemptPhase === "reconciled_not_applied" &&
      (successor.attemptPhase === "prepared" ||
        successor.attemptPhase === "effect_started") &&
      successor.attemptOrdinal === current.attemptOrdinal + 1 &&
      successor.expectedGeneration === current.successorGeneration &&
      successor.expectedGeneration > current.expectedGeneration &&
      strictlyNewAuthority(current.targetAuthority, successor.targetAuthority) &&
      strictlyNewAuthority(current.attemptAuthority, successor.attemptAuthority);
  }
  const noCutRebase =
    current.cutAuthority === null &&
    current.successorGeneration === null &&
    successor.cutAuthority === null &&
    successor.successorGeneration === null &&
    current.attemptPhase === "abandoned_pre_effect" &&
    successor.attemptPhase === "prepared" &&
    successor.attemptOrdinal === current.attemptOrdinal + 1 &&
    current.expectedGeneration !== Number.MAX_SAFE_INTEGER &&
    successor.expectedGeneration === current.expectedGeneration + 1;
  if (noCutRebase) {
    return strictlyNewAuthority(current.targetAuthority, successor.targetAuthority) &&
      strictlyNewAuthority(current.attemptAuthority, successor.attemptAuthority);
  }
  if (
    successor.attemptOrdinal !== current.attemptOrdinal ||
    successor.expectedGeneration !== current.expectedGeneration ||
    !attemptPhaseTransitionAllowed(
      current.attemptPhase,
      successor.attemptPhase,
    ) ||
    !authorityMonotone(current.targetAuthority, successor.targetAuthority) ||
    !authorityMonotone(current.attemptAuthority, successor.attemptAuthority) ||
    !nullableAuthorityMonotone(current.cutAuthority, successor.cutAuthority) ||
    !nullableGenerationMonotone(
      current.successorGeneration,
      successor.successorGeneration,
    )
  ) return false;
  if (
    current.attemptPhase === "prepared" &&
    successor.attemptPhase === "effect_started" &&
    !strictlyNewAuthority(current.attemptAuthority, successor.attemptAuthority)
  ) return false;
  return true;
}

function strictlyNewAuthority(
  current: ArchiveAdmissionAuthority,
  successor: ArchiveAdmissionAuthority,
): boolean {
  return successor.revision > current.revision && successor.hmac !== current.hmac;
}

function authorityMonotone(
  current: ArchiveAdmissionAuthority,
  successor: ArchiveAdmissionAuthority,
): boolean {
  return (
    successor.revision > current.revision && successor.hmac !== current.hmac
  ) || (
    successor.revision === current.revision && successor.hmac === current.hmac
  );
}

function nullableAuthorityMonotone(
  current: ArchiveAdmissionAuthority | null,
  successor: ArchiveAdmissionAuthority | null,
): boolean {
  if (current === null) return successor === null || successor.revision >= 1;
  return successor !== null && authorityMonotone(current, successor);
}

function nullableGenerationMonotone(
  current: number | null,
  successor: number | null,
): boolean {
  if (current === null) return successor === null || successor >= 1;
  return successor === current;
}

function exactFingerprint(descriptor: ArchiveAdmissionDescriptor): string {
  return `exact:${JSON.stringify(descriptor)}`;
}

function archiveLineageKey(
  descriptor: ArchiveAdmissionProvisionalDescriptor,
): string {
  return JSON.stringify([
    "archive",
    descriptor.accountProfileId,
    descriptor.transitionId,
    descriptor.paneId,
    descriptor.purpose,
  ]);
}

function removalLineageKey(
  descriptor: AccountRemovalAdmissionProvisionalDescriptor,
): string {
  return JSON.stringify([
    "account_removal",
    descriptor.accountProfileId,
    descriptor.transitionId,
  ]);
}

function createHandle<T extends object>(): T {
  return Object.freeze(Object.create(null)) as T;
}

function validateAttemptPhase(phase: ArchiveAdmissionAttemptPhase): void {
  if (![
    "abandoned_pre_effect",
    "account_contained",
    "ambiguous",
    "direct_applied",
    "effect_started",
    "prepared",
    "reconciled_applied",
    "reconciled_not_applied",
  ].includes(phase)) {
    throw new ArchiveAdmissionAuthorityError(
      "The provider archive attempt phase is invalid.",
    );
  }
}

function attemptPhaseTransitionAllowed(
  current: ArchiveAdmissionAttemptPhase,
  successor: ArchiveAdmissionAttemptPhase,
): boolean {
  if (current === successor) return true;
  switch (current) {
    case "prepared":
      return successor === "effect_started" ||
        successor === "abandoned_pre_effect" ||
        successor === "reconciled_not_applied" ||
        successor === "account_contained";
    case "effect_started":
      return successor === "ambiguous" ||
        successor === "direct_applied" ||
        successor === "reconciled_not_applied" ||
        successor === "account_contained";
    case "ambiguous":
      return successor === "reconciled_applied" ||
        successor === "reconciled_not_applied" ||
        successor === "account_contained";
    case "direct_applied":
    case "reconciled_applied":
    case "reconciled_not_applied":
    case "abandoned_pre_effect":
      return successor === "account_contained";
    case "account_contained":
      return false;
  }
}

function validatePurpose(purpose: ArchiveAdmissionPurpose): void {
  if (purpose !== "pane_archive" && purpose !== "start_fresh") {
    throw new ArchiveAdmissionAuthorityError(
      "The provider archive admission purpose is invalid.",
    );
  }
}

function validatePositiveGeneration(generation: number, label: string): void {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new ArchiveAdmissionAuthorityError(
      `The provider archive ${label} generation must be a positive safe integer.`,
    );
  }
}

function validateOpaqueIdentity(value: string, label: string): void {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > maximumOpaqueIdentityLength || value.includes("\0")
  ) {
    throw new ArchiveAdmissionAuthorityError(`${label} is invalid.`);
  }
}
