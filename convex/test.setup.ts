export const modules = {
  "./_generated/server.ts": async () => await import("./server"),
  "./accountDeletion.ts": async () => await import("./accountDeletion"),
  "./account.ts": async () => await import("./account"),
  "./attentionNotificationControl.ts": async () =>
    await import("./attentionNotificationControl"),
  "./attentionNotificationDelivery.ts": async () =>
    await import("./attentionNotificationDelivery"),
  "./attentionNotifications.ts": async () =>
    await import("./attentionNotifications"),
  "./authDelivery.ts": async () => await import("./authDelivery"),
  "./authInvites.ts": async () => await import("./authInvites"),
  "./admissionControl.ts": async () => await import("./admissionControl"),
  "./commands.ts": async () => await import("./commands"),
  "./commandLifecycle.ts": async () => await import("./commandLifecycle"),
  "./devices.ts": async () => await import("./devices"),
  "./deviceCommands.ts": async () => await import("./deviceCommands"),
  "./deviceRevocation.ts": async () => await import("./deviceRevocation"),
  "./leases.ts": async () => await import("./leases"),
  "./maintenance.ts": async () => await import("./maintenance"),
  "./memorySync.ts": async () => await import("./memorySync"),
  "./presence.ts": async () => await import("./presence"),
  "./quota.ts": async () => await import("./quota"),
  "./releaseAttestation.ts": async () => await import("./releaseAttestation"),
  "./sessions.ts": async () => await import("./sessions"),
  "./usage.ts": async () => await import("./usage"),
};

// Convex unit tests execute the deliberately unbound tracked attestation. The
// production operator cannot activate that attestation, so marker-2 fixtures
// seed the exact matching state explicitly after quota genesis.
export const trackedCommandCapacityReadiness = Object.freeze({
  activatedAt: 1,
  candidateDeployDigest: "a".repeat(64),
  evidenceDigest: "b".repeat(64),
  lifecycleCapacityVersion: 1 as const,
  runtimeAttestation: Object.freeze({
    bound: false as const,
    schemaIdentity: "hra-release-attestation-v1" as const,
    schemaVersion: 1 as const,
  }),
  schemaIdentity: "hra-command-capacity-readiness-v1" as const,
  schemaVersion: 1 as const,
  targetDigest: "c".repeat(64),
});
