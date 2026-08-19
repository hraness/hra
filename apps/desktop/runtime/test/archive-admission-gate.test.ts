import { describe, expect, test } from "bun:test";
import type { AccountSummary } from "../../contracts/runtime";
import {
  ArchiveAdmissionAuthorityError,
  ArchiveAdmissionGate,
  ArchiveAdmissionHeldError,
  type ArchiveAdmissionDescriptor,
  type ArchiveAdmissionHandle,
  archiveRestartThreadDigest,
} from "../src/accounts/archive-admission-gate";

const accountA = "acct_archive_gate_a" as AccountSummary["id"];
const accountB = "acct_archive_gate_b" as AccountSummary["id"];

function descriptor(
  suffix: string,
  overrides: Partial<ArchiveAdmissionDescriptor> = {},
): ArchiveAdmissionDescriptor {
  return {
    accountProfileId: accountA,
    attemptAuthority: { hmac: "b".repeat(64), revision: 3 },
    attemptOrdinal: 1,
    attemptPhase: "prepared",
    cutAuthority: null,
    expectedGeneration: 7,
    paneId: `pane-${suffix}`,
    purpose: "pane_archive",
    restartThreadDigest: archiveRestartThreadDigest(`thread-${suffix}`),
    successorGeneration: null,
    targetAuthority: { hmac: "a".repeat(64), revision: 2 },
    transitionId: `transition-${suffix}`,
    ...overrides,
  };
}

describe("ArchiveAdmissionGate", () => {
  test("keeps ordinary account admission closed until the final target releases", () => {
    const gate = new ArchiveAdmissionGate();
    const events: boolean[] = [];
    gate.subscribe(accountA, (held) => events.push(held));

    const first = gate.retain(descriptor("first"));
    const second = gate.retain(descriptor("second"));
    expect(events).toEqual([true]);
    expect(gate.isHeld(accountA)).toBeTrue();
    expect(() => gate.assertOrdinaryAdmission(accountA)).toThrow(
      ArchiveAdmissionHeldError,
    );

    gate.release(first);
    expect(gate.isHeld(accountA)).toBeTrue();
    expect(events).toEqual([true]);
    gate.release(second);
    expect(gate.isHeld(accountA)).toBeFalse();
    expect(events).toEqual([true, false]);
    expect(() => gate.assertOrdinaryAdmission(accountA)).not.toThrow();
  });

  test("is idempotent only for an exact descriptor and replaces without a release gap", () => {
    const gate = new ArchiveAdmissionGate();
    const originalDescriptor = descriptor("replace");
    const original = gate.retain(originalDescriptor);
    expect(gate.retain({
      ...originalDescriptor,
      attemptAuthority: { ...originalDescriptor.attemptAuthority },
      targetAuthority: { ...originalDescriptor.targetAuthority },
    })).toBe(original);
    expect(() => gate.retain({
      ...originalDescriptor,
      attemptOrdinal: 2,
    })).toThrow(ArchiveAdmissionAuthorityError);

    const events: boolean[] = [];
    gate.subscribe(accountA, (held) => events.push(held));
    const successorDescriptor = descriptor("replace", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      cutAuthority: { hmac: "d".repeat(64), revision: 5 },
      targetAuthority: { hmac: "e".repeat(64), revision: 6 },
      successorGeneration: 8,
    });
    const successor = gate.replace(original, successorDescriptor);

    expect(successor).not.toBe(original);
    expect(gate.isHeld(accountA)).toBeTrue();
    expect(events).toEqual([]);
    expect(() => gate.require(original)).toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.release(original)).toThrow(ArchiveAdmissionAuthorityError);
    expect(gate.require(successor)).toEqual(successorDescriptor);
    gate.release(successor);
    expect(events).toEqual([false]);
  });

  test("rejects forged, foreign, and stale handles without clearing siblings", () => {
    const gate = new ArchiveAdmissionGate();
    const sibling = gate.retain(descriptor("sibling"));
    const target = gate.retain(descriptor("target"));
    const forged = Object.freeze({}) as ArchiveAdmissionHandle;
    const foreign = new ArchiveAdmissionGate().retain(descriptor("foreign"));

    expect(() => gate.release(forged)).toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.release(foreign)).toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.require(target, accountB)).toThrow(
      ArchiveAdmissionAuthorityError,
    );
    gate.release(target);
    expect(() => gate.release(target)).toThrow(ArchiveAdmissionAuthorityError);
    expect(gate.isHeld(accountA)).toBeTrue();
    expect(gate.require(sibling).paneId).toBe("pane-sibling");
  });

  test("validates every durable authority component before retaining a hold", () => {
    const gate = new ArchiveAdmissionGate();
    expect(() => gate.retain(descriptor("bad-target", {
      targetAuthority: { hmac: "not-a-hmac", revision: 1 },
    }))).toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.retain(descriptor("bad-attempt", {
      attemptAuthority: { hmac: "b".repeat(64), revision: 0 },
    }))).toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.retain(descriptor("bad-cut", {
      cutAuthority: { hmac: "D".repeat(64), revision: 1 },
    }))).toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.retain(descriptor("bad-generation", {
      expectedGeneration: 0,
    }))).toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.retain(descriptor("bad-ordinal", {
      attemptOrdinal: 0,
    }))).toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.retain(descriptor("unbound-successor", {
      successorGeneration: 2,
    }))).toThrow(ArchiveAdmissionAuthorityError);
    expect(gate.isHeld(accountA)).toBeFalse();
  });

  test("promotes a provisional hold without a gap and gives it no exact authority", () => {
    const gate = new ArchiveAdmissionGate();
    const events: boolean[] = [];
    gate.subscribe(accountA, (held) => events.push(held));
    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-provisional",
      purpose: "pane_archive",
      transitionId: "transition-provisional",
    });
    expect(() => gate.require(provisional as unknown as ArchiveAdmissionHandle))
      .toThrow(ArchiveAdmissionAuthorityError);
    const exact = gate.promote(provisional, descriptor("provisional"));
    expect(events).toEqual([true]);
    expect(gate.isHeld(accountA)).toBeTrue();
    expect(() => gate.abortProvisional(provisional)).toThrow(
      ArchiveAdmissionAuthorityError,
    );
    gate.release(exact);
    expect(events).toEqual([true, false]);
  });

  test("allows only the exact contained N to authorized N+1 rebase", () => {
    const gate = new ArchiveAdmissionGate();
    const prepared = gate.retain(descriptor("rebase"));
    const effectStarted = gate.replace(prepared, descriptor("rebase", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptPhase: "effect_started",
    }));
    const ambiguous = gate.replace(effectStarted, descriptor("rebase", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptPhase: "ambiguous",
      cutAuthority: { hmac: "d".repeat(64), revision: 5 },
      successorGeneration: 8,
      targetAuthority: { hmac: "e".repeat(64), revision: 6 },
    }));
    const contained = gate.replace(ambiguous, descriptor("rebase", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptPhase: "reconciled_not_applied",
      cutAuthority: { hmac: "d".repeat(64), revision: 5 },
      successorGeneration: 8,
      targetAuthority: { hmac: "e".repeat(64), revision: 6 },
    }));
    expect(() => gate.replace(contained, descriptor("rebase", {
      attemptAuthority: { hmac: "f".repeat(64), revision: 5 },
      attemptOrdinal: 2,
      expectedGeneration: 9,
      targetAuthority: { hmac: "1".repeat(64), revision: 7 },
    }))).toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.replace(contained, descriptor("rebase", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptOrdinal: 2,
      expectedGeneration: 8,
      targetAuthority: { hmac: "e".repeat(64), revision: 6 },
    }))).toThrow(ArchiveAdmissionAuthorityError);
    const rebased = gate.replace(contained, descriptor("rebase", {
      attemptAuthority: { hmac: "f".repeat(64), revision: 7 },
      attemptOrdinal: 2,
      expectedGeneration: 8,
      targetAuthority: { hmac: "1".repeat(64), revision: 8 },
    }));
    expect(gate.isHeld(accountA)).toBeTrue();
    expect(gate.require(rebased).expectedGeneration).toBe(8);
  });

  test("permits only a keyed no-effect N to N+1 attempt rebase", () => {
    const gate = new ArchiveAdmissionGate();
    const prepared = gate.retain(descriptor("no-effect-rebase"));
    const abandoned = gate.replace(prepared, descriptor("no-effect-rebase", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptPhase: "abandoned_pre_effect",
    }));
    const next = descriptor("no-effect-rebase", {
      attemptAuthority: { hmac: "2".repeat(64), revision: 7 },
      attemptOrdinal: 2,
      expectedGeneration: 8,
      targetAuthority: { hmac: "3".repeat(64), revision: 8 },
    });
    expect(() => gate.replace(abandoned, {
      ...next,
      expectedGeneration: 7,
    })).toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.replace(abandoned, {
      ...next,
      attemptOrdinal: 1,
    })).toThrow(ArchiveAdmissionAuthorityError);
    const rebased = gate.replace(abandoned, next);
    expect(gate.require(rebased)).toEqual(next);
    expect(gate.isHeld(accountA)).toBeTrue();
  });

  test("grants one same-process mutation after an atomic contained N to effect-started N+1 rebase", () => {
    const gate = new ArchiveAdmissionGate();
    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-contained-effect-rebase",
      purpose: "pane_archive",
      transitionId: "transition-contained-effect-rebase",
    });
    const prepared = gate.promote(
      provisional,
      descriptor("contained-effect-rebase"),
    );
    const effectStarted = gate.replace(prepared, descriptor(
      "contained-effect-rebase",
      {
        attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
        attemptPhase: "effect_started",
      },
    ));
    const ambiguous = gate.replace(effectStarted, descriptor(
      "contained-effect-rebase",
      {
        attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
        attemptPhase: "ambiguous",
        cutAuthority: { hmac: "d".repeat(64), revision: 5 },
        successorGeneration: 8,
        targetAuthority: { hmac: "e".repeat(64), revision: 6 },
      },
    ));
    const notAppliedDescriptor = descriptor("contained-effect-rebase", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptPhase: "reconciled_not_applied",
      cutAuthority: { hmac: "d".repeat(64), revision: 5 },
      successorGeneration: 8,
      targetAuthority: { hmac: "e".repeat(64), revision: 6 },
    });
    const notApplied = gate.replace(ambiguous, notAppliedDescriptor);
    const successorDescriptor = descriptor("contained-effect-rebase", {
      attemptAuthority: { hmac: "f".repeat(64), revision: 7 },
      attemptOrdinal: 2,
      attemptPhase: "effect_started",
      expectedGeneration: 8,
      targetAuthority: { hmac: "1".repeat(64), revision: 8 },
    });
    const successor = gate.replace(notApplied, successorDescriptor);
    const claim = gate.claimThreadArchiveEffect(successor);
    gate.beginThreadArchiveEffect(claim);
    expect(() => gate.claimThreadArchiveEffect(successor)).toThrow(
      ArchiveAdmissionAuthorityError,
    );

    const replayedGate = new ArchiveAdmissionGate();
    const replayedNotApplied = replayedGate.retain(notAppliedDescriptor);
    const replayedSuccessor = replayedGate.replace(
      replayedNotApplied,
      successorDescriptor,
    );
    expect(() => replayedGate.claimThreadArchiveEffect(replayedSuccessor))
      .toThrow(ArchiveAdmissionAuthorityError);
  });

  test("activates only an exact replayed contained successor before one new mutation", () => {
    const notAppliedDescriptor = descriptor("activated-contained-rebase", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptPhase: "reconciled_not_applied",
      cutAuthority: { hmac: "d".repeat(64), revision: 5 },
      successorGeneration: 8,
      targetAuthority: { hmac: "e".repeat(64), revision: 6 },
    });
    const successorDescriptor = descriptor("activated-contained-rebase", {
      attemptAuthority: { hmac: "f".repeat(64), revision: 7 },
      attemptOrdinal: 2,
      attemptPhase: "effect_started",
      expectedGeneration: 8,
      targetAuthority: { hmac: "1".repeat(64), revision: 8 },
    });
    const gate = new ArchiveAdmissionGate();
    const replayed = gate.retain(notAppliedDescriptor);
    expect(() => gate.claimThreadArchiveEffect(replayed)).toThrow(
      ArchiveAdmissionAuthorityError,
    );

    const activated = gate.activateContainedSuccessor(replayed);
    expect(activated).not.toBe(replayed);
    expect(gate.require(activated)).toEqual(notAppliedDescriptor);
    expect(() => gate.require(replayed)).toThrow(ArchiveAdmissionAuthorityError);
    expect(gate.activateContainedSuccessor(activated)).toBe(activated);

    const successor = gate.replace(activated, successorDescriptor);
    const claim = gate.claimThreadArchiveEffect(successor);
    gate.beginThreadArchiveEffect(claim);
    expect(() => gate.claimThreadArchiveEffect(successor)).toThrow(
      ArchiveAdmissionAuthorityError,
    );

    const wrongPhase = gate.retain(descriptor("activation-wrong-phase"));
    expect(() => gate.activateContainedSuccessor(wrongPhase)).toThrow(
      ArchiveAdmissionAuthorityError,
    );
    const removal = gate.retainAccountRemovalProvisional({
      accountProfileId: accountA,
      expectedGeneration: 7,
      transitionId: "removal-activation-block",
    });
    expect(() => gate.activateContainedSuccessor(successor)).toThrow(
      ArchiveAdmissionAuthorityError,
    );
    gate.abortAccountRemovalProvisional(removal);
  });

  test("represents fence-started before the exact successor becomes known", () => {
    const gate = new ArchiveAdmissionGate();
    const prepared = gate.retain(descriptor("cut-stages"));
    const direct = gate.replace(prepared, descriptor("cut-stages", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptPhase: "effect_started",
    }));
    const cutStartedDescriptor = descriptor("cut-stages", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptPhase: "effect_started",
      cutAuthority: { hmac: "4".repeat(64), revision: 9 },
    });
    const cutStarted = gate.replace(direct, cutStartedDescriptor);
    expect(gate.require(cutStarted)).toMatchObject({
      cutAuthority: { hmac: "4".repeat(64), revision: 9 },
      successorGeneration: null,
    });
    const successor = gate.replace(cutStarted, {
      ...cutStartedDescriptor,
      attemptPhase: "ambiguous",
      successorGeneration: 8,
    });
    expect(gate.require(successor).successorGeneration).toBe(8);
  });

  test("keeps the restart target immutable and successor generation exact and set once", () => {
    const gate = new ArchiveAdmissionGate();
    const prepared = gate.retain(descriptor("immutable"));
    expect(() => gate.replace(prepared, descriptor("immutable", {
      attemptAuthority: { hmac: "b".repeat(64), revision: 4 },
    }))).toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.replace(prepared, descriptor("immutable", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      restartThreadDigest: archiveRestartThreadDigest("retargeted-thread"),
    }))).toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.replace(prepared, descriptor("immutable", {
      cutAuthority: { hmac: "d".repeat(64), revision: 5 },
      successorGeneration: 9,
    }))).toThrow(ArchiveAdmissionAuthorityError);
    const cut = gate.replace(prepared, descriptor("immutable", {
      cutAuthority: { hmac: "d".repeat(64), revision: 5 },
      successorGeneration: 8,
    }));
    expect(() => gate.replace(cut, descriptor("immutable", {
      cutAuthority: { hmac: "e".repeat(64), revision: 6 },
      successorGeneration: null,
    }))).toThrow(ArchiveAdmissionAuthorityError);
  });

  test("grants one mutation claim only to a live provisional lineage", () => {
    const gate = new ArchiveAdmissionGate();
    const replayedEffect = gate.retain(descriptor("replayed-effect", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptPhase: "effect_started",
    }));
    expect(() => gate.claimThreadArchiveEffect(replayedEffect)).toThrow(
      ArchiveAdmissionAuthorityError,
    );

    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-live-effect",
      purpose: "pane_archive",
      transitionId: "transition-live-effect",
    });
    const prepared = gate.promote(provisional, descriptor("live-effect"));
    const effectStarted = gate.replace(prepared, descriptor("live-effect", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptPhase: "effect_started",
    }));
    const firstClaim = gate.claimThreadArchiveEffect(effectStarted);
    expect(() => gate.claimThreadArchiveEffect(effectStarted)).toThrow(
      ArchiveAdmissionAuthorityError,
    );
    gate.abortThreadArchiveEffectClaim(firstClaim);
    const finalClaim = gate.claimThreadArchiveEffect(effectStarted);
    gate.beginThreadArchiveEffect(finalClaim);
    expect(() => gate.abortThreadArchiveEffectClaim(finalClaim)).toThrow(
      ArchiveAdmissionAuthorityError,
    );
    expect(() => gate.claimThreadArchiveEffect(effectStarted)).toThrow(
      ArchiveAdmissionAuthorityError,
    );
  });

  test("atomically promotes a provisional hold to one effect-started mutation", () => {
    const gate = new ArchiveAdmissionGate();
    const events: boolean[] = [];
    gate.subscribe(accountA, (held) => events.push(held));
    const provisional = gate.retainProvisional({
      accountProfileId: accountA,
      paneId: "pane-atomic-effect",
      purpose: "pane_archive",
      transitionId: "transition-atomic-effect",
    });
    const effectDescriptor = descriptor("atomic-effect", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptPhase: "effect_started",
    });
    expect(() => gate.promoteEffectStarted(provisional, {
      ...effectDescriptor,
      cutAuthority: { hmac: "d".repeat(64), revision: 5 },
    })).toThrow(ArchiveAdmissionAuthorityError);

    const effectStarted = gate.promoteEffectStarted(
      provisional,
      effectDescriptor,
    );
    expect(events).toEqual([true]);
    expect(gate.require(effectStarted)).toEqual(effectDescriptor);
    const claim = gate.claimThreadArchiveEffect(effectStarted);
    gate.beginThreadArchiveEffect(claim);
    expect(() => gate.claimThreadArchiveEffect(effectStarted)).toThrow(
      ArchiveAdmissionAuthorityError,
    );
    expect(() => gate.abortProvisional(provisional)).toThrow(
      ArchiveAdmissionAuthorityError,
    );
  });

  test("keeps a replayed prepared successor recovery-only without a durable launch reservation", () => {
    const gate = new ArchiveAdmissionGate();
    const replayedPrepared = gate.retain(descriptor("replayed-prepared"));
    const abandoned = gate.replace(replayedPrepared, descriptor("replayed-prepared", {
      attemptAuthority: { hmac: "c".repeat(64), revision: 4 },
      attemptPhase: "abandoned_pre_effect",
    }));
    const successorPrepared = gate.replace(abandoned, descriptor("replayed-prepared", {
      attemptAuthority: { hmac: "d".repeat(64), revision: 5 },
      attemptOrdinal: 2,
      expectedGeneration: 8,
      targetAuthority: { hmac: "e".repeat(64), revision: 6 },
    }));
    const successorEffect = gate.replace(
      successorPrepared,
      descriptor("replayed-prepared", {
        attemptAuthority: { hmac: "f".repeat(64), revision: 7 },
        attemptOrdinal: 2,
        attemptPhase: "effect_started",
        expectedGeneration: 8,
        targetAuthority: { hmac: "e".repeat(64), revision: 6 },
      }),
    );

    expect(gate.isHeld(accountA)).toBeTrue();
    expect(() => gate.claimThreadArchiveEffect(successorEffect)).toThrow(
      ArchiveAdmissionAuthorityError,
    );
  });

  test("makes provisional and durable account removal dominate archive recovery", () => {
    const gate = new ArchiveAdmissionGate();
    const archive = gate.retain(descriptor("removal-dominance"));
    const removalProvisional = gate.retainAccountRemovalProvisional({
      accountProfileId: accountA,
      expectedGeneration: 7,
      transitionId: "removal-dominance",
    });
    expect(() => gate.require(archive)).toThrow(ArchiveAdmissionAuthorityError);
    const removal = gate.promoteAccountRemoval(removalProvisional, {
      accountProfileId: accountA,
      cutAuthority: { hmac: "9".repeat(64), revision: 1 },
      expectedGeneration: 7,
      transitionId: "removal-dominance",
    });
    expect(() => gate.require(archive)).toThrow(ArchiveAdmissionAuthorityError);
    gate.releaseAccountRemoval(removal);
    expect(gate.require(archive).paneId).toBe("pane-removal-dominance");
  });

  test("keeps account-removal root authority targetless and operation-specific", () => {
    const gate = new ArchiveAdmissionGate();
    const events: boolean[] = [];
    gate.subscribe(accountA, (held) => events.push(held));
    const provisional = gate.retainAccountRemovalProvisional({
      accountProfileId: accountA,
      expectedGeneration: 11,
      transitionId: "account-removal-1",
    });
    expect(() => gate.requireAccountRemoval(
      provisional as unknown as Parameters<typeof gate.requireAccountRemoval>[0],
    )).toThrow(ArchiveAdmissionAuthorityError);
    const removal = gate.promoteAccountRemoval(provisional, {
      accountProfileId: accountA,
      cutAuthority: { hmac: "9".repeat(64), revision: 2 },
      expectedGeneration: 11,
      transitionId: "account-removal-1",
    });
    expect(events).toEqual([true]);
    expect(gate.requireAccountRemoval(removal)).toMatchObject({
      accountProfileId: accountA,
      expectedGeneration: 11,
    });
    expect(() => gate.require(removal as unknown as ArchiveAdmissionHandle))
      .toThrow(ArchiveAdmissionAuthorityError);
    expect(() => gate.assertOrdinaryAdmission(accountA)).toThrow(
      ArchiveAdmissionHeldError,
    );
    expect(() => gate.abortAccountRemovalProvisional(provisional)).toThrow(
      ArchiveAdmissionAuthorityError,
    );
    gate.releaseAccountRemoval(removal);
    expect(gate.isHeld(accountA)).toBeFalse();
    expect(events).toEqual([true, false]);
  });
});
