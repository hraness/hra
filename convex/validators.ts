import { v } from "convex/values";

export const authAttemptKind = v.union(v.literal("send"), v.literal("verify"));
export const authSubjectStatus = v.union(v.literal("active"), v.literal("disabled"));
export const authAdmissionState = v.union(v.literal("open"), v.literal("frozen"));
// Break-glass admission (`authAdmissionState`) gates every authenticated path.
// New-identity admission is the separate, narrower control that decides whether
// a first `authSubjects` row may be created without an invitation. An absent
// stored value always means `invite_only`.
export const newIdentityAdmissionState = v.union(
  v.literal("invite_only"),
  v.literal("open"),
);
// Only open admission is recorded on the subject. An invited subject keeps its
// `admissionInviteId` instead, and an absent marker never means "no invite
// required".
export const authSubjectAdmittedBy = v.literal("open");
export const challengeDeliveryState = v.union(
  v.literal("reserved"),
  v.literal("accepted"),
  v.literal("ambiguous"),
);
export const deviceStatus = v.union(
  v.literal("pending"),
  v.literal("active"),
  v.literal("revoked"),
);
// A device row written before browser enrollment carries no class. An absent
// field therefore means `daemon`, and `deviceClassOf` is the only reader.
export const deviceClass = v.union(v.literal("daemon"), v.literal("browser"));
export const sessionStatus = v.union(
  v.literal("active"),
  v.literal("idle"),
  v.literal("terminal"),
  v.literal("orphaned"),
);
export const syncStream = v.union(v.literal("compact"), v.literal("detail"));
export const commandKind = v.union(
  v.literal("send"),
  v.literal("queue"),
  v.literal("steer"),
  v.literal("stop"),
  v.literal("set_model"),
  v.literal("set_fast"),
  v.literal("resolve_interaction"),
  v.literal("send_or_steer"),
  v.literal("set_approval_mode"),
  v.literal("set_show_thinking"),
  v.literal("set_default_preset"),
  v.literal("archive_session"),
  v.literal("rename_session"),
  v.literal("set_gateway_key"),
);
export const commandState = v.union(
  v.literal("pending"),
  v.literal("prepared"),
  v.literal("effect_started"),
  v.literal("applied"),
  v.literal("failed"),
  v.literal("ambiguous"),
  v.literal("cancelled"),
  v.literal("expired"),
);
export const accountBindingState = v.union(v.literal("present"), v.literal("removed"));
export const usageAdmissionDisposition = v.union(
  v.literal("stored"),
  v.literal("coalesced"),
);
export const accountDeletionState = v.union(
  v.literal("pending"),
  v.literal("draining"),
  v.literal("complete"),
);
export const accountDeletionCategory = v.union(
  v.literal("commands_and_leases"),
  v.literal("chunks_and_epochs"),
  v.literal("session_heads"),
  v.literal("usage_and_bindings"),
  v.literal("codex_accounts"),
  v.literal("device_custody"),
  v.literal("devices"),
  v.literal("receipts_and_events"),
  v.literal("auth_tokens_and_verifiers"),
  v.literal("auth_sessions"),
  v.literal("auth_challenges"),
  v.literal("auth_accounts"),
  v.literal("user_and_subject"),
  v.literal("complete"),
);
export const deviceRevocationState = v.union(
  v.literal("pending"),
  v.literal("draining"),
  v.literal("complete"),
);
export const deviceRevocationCategory = v.union(
  v.literal("sessions"),
  v.literal("leases"),
  v.literal("commands"),
  v.literal("bindings"),
  v.literal("custody"),
  v.literal("presence"),
  v.literal("complete"),
);
export const invitePurpose = v.union(v.literal("identity"), v.literal("device"));
export const inviteState = v.union(
  v.literal("issued"),
  v.literal("bound_to_email"),
  v.literal("consumed"),
  v.literal("revoked"),
);
export const quotaCategory = v.union(
  v.literal("identity"),
  v.literal("device"),
  v.literal("account"),
  v.literal("session"),
  v.literal("chunk"),
  v.literal("usage"),
  v.literal("command"),
  v.literal("custody"),
  v.literal("receipt"),
  v.literal("security"),
  v.literal("job"),
);
export const quotaEnforcement = v.union(v.literal("shadow"), v.literal("hard"));
export const quotaUserResource = v.union(
  v.literal("device"),
  v.literal("codex_account"),
  v.literal("session_head"),
  v.literal("session_chunk"),
  v.literal("nonterminal_command"),
  v.literal("live_chunk"),
);
export const quotaAccountResource = v.literal("usage_snapshot");
export const maintenanceCategory = v.union(
  v.literal("auth_attempts"),
  v.literal("otp_challenges"),
  v.literal("auth_invites"),
  v.literal("abandoned_identities"),
  v.literal("bind_challenges"),
  v.literal("device_presence"),
  v.literal("idempotency_receipts"),
  v.literal("pending_commands"),
  v.literal("terminal_commands"),
  v.literal("security_events"),
  v.literal("usage_snapshots"),
  v.literal("account_deletion_receipts"),
  v.literal("device_revocation_jobs"),
  v.literal("live_tail_chunks"),
);

export const encryptedEnvelope = v.object({
  algorithm: v.literal("A256GCM"),
  ciphertext: v.string(),
  keyVersion: v.number(),
  nonce: v.string(),
});

// Usage applies its tighter ciphertext-character bound in the mutation parser.
// The named validator keeps that distinct contract visible in the table schema.
export const usageEncryptedEnvelope = encryptedEnvelope;

export const usageAdmissionAuthority = v.object({
  cursor: v.object({
    digest: v.string(),
    disposition: usageAdmissionDisposition,
    observedAt: v.number(),
    sourceRevision: v.number(),
  }),
  lastAcceptedAt: v.number(),
});

export const wrappedKeyEnvelope = v.object({
  algorithm: v.literal("P256-HKDF-SHA256+A256GCM"),
  ciphertext: v.string(),
  ephemeralPublicKey: v.string(),
  keyVersion: v.number(),
  nonce: v.string(),
});

export const authorityTuple = v.object({
  bootGeneration: v.number(),
  bootId: v.string(),
  fence: v.number(),
});
