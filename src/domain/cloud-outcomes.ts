// Closed failure codes that the cloud control port raises and the daemon maps
// to command errors. They live in the domain so the daemon never loads cloud
// code to recognise them.

export type AccountKeyLossPreconditionFailure =
  | "already_ready"
  | "auth_identity_unbound"
  | "authority_changed"
  | "device_unregistered"
  | "observation_missing"
  | "signed_out";

export class AccountKeyLossPreconditionError extends Error {
  constructor(readonly code: AccountKeyLossPreconditionFailure) {
    super(`Account-key loss acknowledgement precondition failed: ${code}.`);
    this.name = "AccountKeyLossPreconditionError";
  }
}

export type CloudProjectionRecoveryAdmissionFailure =
  | "identity_or_session_conflict"
  | "idempotency_authority_invalid"
  | "journal_capacity"
  | "unsettled_session";

export class CloudProjectionRecoveryAdmissionError extends Error {
  readonly code: CloudProjectionRecoveryAdmissionFailure;

  constructor(code: CloudProjectionRecoveryAdmissionFailure) {
    super(`Cloud projection recovery admission failed: ${code}.`);
    this.name = "CloudProjectionRecoveryAdmissionError";
    this.code = code;
  }
}

// AES-GCM message budget exhaustion for one account key version. Raised by the
// cloud encryption layer; the daemon maps it to a closed RECOVERY_REQUIRED failure.
export class KeyRotationRequiredError extends Error {
  readonly code = "KEY_ROTATION_REQUIRED" as const;
  readonly keyVersion: number;

  constructor(keyVersion: number) {
    super(
      `Account key version ${keyVersion} reached its AES-GCM message budget. `
      + "Rotate the account key before encrypting more cloud content.",
    );
    this.name = "KeyRotationRequiredError";
    this.keyVersion = keyVersion;
  }
}
