import { describe, expect, test } from "bun:test";
import type { RunPhase } from "@hraness/agent-tasks-protocol";
import {
  MAX_RUN_DISPLAY_EVENTS,
  MAX_RUN_REASONING_SUMMARY_EVENTS,
  MAX_RUN_TOOL_ACTIVITY_EVENTS,
  publicRunEventKindSchema,
} from "@hraness/agent-tasks-protocol";
import { assertProperty, fc } from "@hra-internal/test";

import {
  CANDIDATE_ROTATION_COOLDOWN_MS,
  MAX_CANDIDATE_EVALUATIONS_PER_HEARTBEAT,
  candidateRowsToRotate,
  contiguousEventBatch,
  dispatchCandidateExpansionTake,
  dispatchCandidateIsEligible,
  dispatchCandidateScanTake,
  dispatchClaimLeaseDisposition,
  dispatchBindingTupleMatches,
  dispatchRetryAllowed,
  dispatchSubmissionAuthorityMatches,
  dispatchSubmissionInputRevisionMatches,
  dispatchTenantTupleMatches,
  heartbeatDisposition,
  planFairEligibleDispatchCandidates,
  rejectedSubmissionMatchesDispatch,
  retainedTerminalRunIds,
  resolvedAmbiguousDispatchPhase,
  runnerAuthorityClockMatches,
  runnerAuthorityDisposition,
  runDisplayBudgetAfterBatch,
  runEventSequenceAllowed,
  scheduledDispatchExpiryDisposition,
  selectFairDispatchCandidateRows,
  storedRunEventPayloadMatches,
  taskDispatchBlocksTaskRelease,
} from "./dispatchLaws";

describe("dispatch property laws", () => {
  test("fair candidate selection is bounded, permutation-invariant, and preserves repository heads", () => {
    assertProperty(fc.property(
      fc.integer({ min: 1, max: 64 }),
      fc.integer({ min: 1, max: 32 }),
      fc.integer({ min: 0, max: 64 }),
      (repositoryCount, limit, extraCount) => {
        const heads = Array.from({ length: repositoryCount }, (_, index) => ({
          publicId: `run_head_${index}`,
          queuedAt: index * 2,
          repositoryId: `repository_${index}`,
        }));
        const extras = Array.from({ length: extraCount }, (_, index) => ({
          publicId: `run_extra_${index}`,
          queuedAt: repositoryCount * 2 + index,
          repositoryId: `repository_${index % repositoryCount}`,
        }));
        const forward = selectFairDispatchCandidateRows({
          expandedRows: [...heads, ...extras],
          headRows: heads,
          limit,
        });
        const reversed = selectFairDispatchCandidateRows({
          expandedRows: [...extras, ...heads].reverse(),
          headRows: [...heads].reverse(),
          limit,
        });
        expect(forward).toEqual(reversed);
        expect(forward).not.toBeNull();
        expect(forward?.length).toBeLessThanOrEqual(limit);
        const expectedHeads = [...heads]
          .sort((left, right) => left.repositoryId.localeCompare(right.repositoryId))
          .slice(0, Math.min(repositoryCount, limit));
        expect(forward?.slice(0, expectedHeads.length)).toEqual(expectedHeads);
        expect(forward?.filter(({ publicId }) => publicId.startsWith("run_head_")))
          .toEqual(expectedHeads);
      },
    ));
  });

  test("candidate discovery and rotation stay within explicit fixed bounds", () => {
    assertProperty(fc.property(
      fc.integer({ min: 0, max: 128 }),
      (nonemptyRepositoryCount) => {
        const expansionTake = dispatchCandidateExpansionTake(nonemptyRepositoryCount, 32);
        const scanTake = dispatchCandidateScanTake(nonemptyRepositoryCount, 32);
        expect(expansionTake).toBeGreaterThanOrEqual(0);
        expect(scanTake).toBeGreaterThanOrEqual(0);
        expect(scanTake).toBeLessThanOrEqual(MAX_CANDIDATE_EVALUATIONS_PER_HEARTBEAT);
        const evaluatedRows = nonemptyRepositoryCount * scanTake;
        const dispatchRowsRead = nonemptyRepositoryCount +
          nonemptyRepositoryCount * (scanTake + 1);
        expect(evaluatedRows).toBeLessThanOrEqual(MAX_CANDIDATE_EVALUATIONS_PER_HEARTBEAT);
        expect(dispatchRowsRead).toBeLessThanOrEqual(768);
      },
    ));
  });

  test("complete all-ineligible pages cause no queue-order write", () => {
    assertProperty(fc.property(
      fc.integer({ min: 0, max: 32 }),
      (rowCount) => {
        const rows = Array.from({ length: rowCount }, (_, index) => ({
          eligible: false,
          publicId: `run_blocked_${index}`,
          queuedAt: index,
          repositoryId: "repository_a",
        }));
        const plan = planFairEligibleDispatchCandidates({ limit: 32, rows });
        expect(plan?.selected).toEqual([]);
        expect(candidateRowsToRotate({
          cooldownMs: CANDIDATE_ROTATION_COOLDOWN_MS,
          deferredPublicIds: plan?.deferredPublicIds ?? [],
          maximumRows: 32,
          now: CANDIDATE_ROTATION_COOLDOWN_MS,
          rows,
          truncatedRepositoryIds: [],
        })).toEqual([]);
      },
    ));
  });

  test("an arbitrary ineligible prefix eventually exposes eligible work", () => {
    assertProperty(fc.property(
      fc.integer({ min: 0, max: 128 }),
      fc.integer({ min: 2, max: 32 }),
      (prefixLength, scanTake) => {
        let clock = prefixLength + 2;
        let now = CANDIDATE_ROTATION_COOLDOWN_MS;
        let rows = [
          ...Array.from({ length: prefixLength }, (_, index) => ({
            candidateOrderAt: index,
            eligible: false,
            publicId: `run_blocked_${index.toString().padStart(3, "0")}`,
            queuedAt: index,
            repositoryId: "repository_a",
          })),
          {
            candidateOrderAt: prefixLength,
            eligible: true,
            publicId: "run_ready",
            queuedAt: prefixLength,
            repositoryId: "repository_a",
          },
        ];
        let exposed = false;
        for (let attempt = 0; attempt <= Math.ceil(prefixLength / scanTake); attempt += 1) {
          rows = [...rows].sort((left, right) =>
            left.candidateOrderAt - right.candidateOrderAt ||
            left.queuedAt - right.queuedAt ||
            left.publicId.localeCompare(right.publicId));
          const page = rows.slice(0, scanTake + 1);
          const scanned = page.slice(0, scanTake);
          const plan = planFairEligibleDispatchCandidates({ limit: 1, rows: scanned });
          expect(plan).not.toBeNull();
          if (plan?.selected.some(({ publicId }) => publicId === "run_ready") === true) {
            exposed = true;
            break;
          }
          const rotations = candidateRowsToRotate({
            cooldownMs: CANDIDATE_ROTATION_COOLDOWN_MS,
            deferredPublicIds: plan?.deferredPublicIds ?? [],
            maximumRows: scanTake,
            now,
            rows: scanned,
            truncatedRepositoryIds: page.length > scanTake ? ["repository_a"] : [],
          });
          expect(rotations).not.toBeNull();
          const rotated = new Set(rotations?.map(({ publicId }) => publicId) ?? []);
          rows = rows.map((row) => rotated.has(row.publicId)
            ? { ...row, candidateOrderAt: clock++, candidateRotationAt: now }
            : row);
          now += CANDIDATE_ROTATION_COOLDOWN_MS + 1;
        }
        expect(exposed).toBe(true);
      },
    ));
  });

  test("10,000 blocked rows expose ready work within the fixed evaluation budget", () => {
    const prefixLength = 10_000;
    const scanTake = dispatchCandidateScanTake(1, 1);
    expect(scanTake).toBe(MAX_CANDIDATE_EVALUATIONS_PER_HEARTBEAT);
    let clock = prefixLength + 2;
    let now = CANDIDATE_ROTATION_COOLDOWN_MS;
    let rows = [
      ...Array.from({ length: prefixLength }, (_, index) => ({
        candidateOrderAt: index,
        eligible: false,
        publicId: `run_stress_blocked_${index.toString().padStart(5, "0")}`,
        queuedAt: index,
        repositoryId: "repository_stress",
      })),
      {
        candidateOrderAt: prefixLength,
        eligible: true,
        publicId: "run_stress_ready",
        queuedAt: prefixLength,
        repositoryId: "repository_stress",
      },
    ];
    let exposedAt: number | undefined;
    const maximumHeartbeats = Math.ceil(prefixLength / scanTake) + 1;
    for (let heartbeat = 1; heartbeat <= maximumHeartbeats; heartbeat += 1) {
      rows = [...rows].sort((left, right) =>
        left.candidateOrderAt - right.candidateOrderAt ||
        left.queuedAt - right.queuedAt ||
        left.publicId.localeCompare(right.publicId));
      const page = rows.slice(0, scanTake + 1);
      const scanned = page.slice(0, scanTake);
      expect(scanned.length).toBeLessThanOrEqual(MAX_CANDIDATE_EVALUATIONS_PER_HEARTBEAT);
      const plan = planFairEligibleDispatchCandidates({ limit: 1, rows: scanned });
      expect(plan).not.toBeNull();
      if (plan?.selected.some(({ publicId }) => publicId === "run_stress_ready") === true) {
        exposedAt = heartbeat;
        break;
      }
      const rotations = candidateRowsToRotate({
        cooldownMs: CANDIDATE_ROTATION_COOLDOWN_MS,
        deferredPublicIds: plan?.deferredPublicIds ?? [],
        maximumRows: scanTake,
        now,
        rows: scanned,
        truncatedRepositoryIds: page.length > scanTake ? ["repository_stress"] : [],
      });
      expect(rotations).not.toBeNull();
      const rotated = new Set(rotations?.map(({ publicId }) => publicId) ?? []);
      rows = rows.map((row) => rotated.has(row.publicId)
        ? { ...row, candidateOrderAt: clock++, candidateRotationAt: now }
        : row);
      now += CANDIDATE_ROTATION_COOLDOWN_MS + 1;
    }
    expect(exposedAt).toBeDefined();
    expect(exposedAt).toBeLessThanOrEqual(maximumHeartbeats);
  });

  test("candidate ties are deterministic under every input permutation", () => {
    assertProperty(fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 12 }), {
        minLength: 1,
        maxLength: 64,
      }),
      (publicIds) => {
        const rows = publicIds.map((publicId, index) => ({
          candidateOrderAt: 1,
          eligible: true,
          publicId,
          queuedAt: 1,
          repositoryId: `repository_${index}`,
        }));
        const forward = planFairEligibleDispatchCandidates({ limit: 32, rows });
        const reversed = planFairEligibleDispatchCandidates({
          limit: 32,
          rows: [...rows].reverse(),
        });
        expect(forward).toEqual(reversed);
      },
    ));
  });

  test("a one-claim consumer sees every eligible repository in one finite cursor cycle", () => {
    assertProperty(fc.property(
      fc.integer({ min: 1, max: 64 }),
      (repositoryCount) => {
        const heads = Array.from({ length: repositoryCount }, (_, index) => ({
          publicId: `run_cursor_${index.toString().padStart(3, "0")}`,
          queuedAt: index,
          repositoryId: `repository_${index.toString().padStart(3, "0")}`,
        }));
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let heartbeat = 0; heartbeat < repositoryCount; heartbeat += 1) {
          const selected = selectFairDispatchCandidateRows({
            expandedRows: [],
            headRows: heads,
            limit: 1,
            ...(cursor === undefined ? {} : { repositoryCursor: cursor }),
          });
          const head = selected?.[0];
          expect(head).toBeDefined();
          if (head === undefined) throw new Error("Cursor cycle lost every repository head");
          expect(seen.has(head.repositoryId)).toBe(false);
          seen.add(head.repositoryId);
          cursor = head.repositoryId;
        }
        expect(seen.size).toBe(repositoryCount);
      },
    ));
  });

  test("one to four free slots cover 128 eligible repositories without overlap", () => {
    const heads = Object.freeze(
      Array.from({ length: 128 }, (_, index) => Object.freeze({
        publicId: `run_capacity_${index.toString().padStart(3, "0")}`,
        queuedAt: index,
        repositoryId: `repository_${index.toString().padStart(3, "0")}`,
      })),
    );
    assertProperty(fc.property(
      fc.integer({ min: 1, max: 4 }),
      (freeSlots) => {
        const seen = new Set<string>();
        let cursor: string | undefined;
        for (let heartbeat = 0; heartbeat < Math.ceil(heads.length / freeSlots); heartbeat += 1) {
          const selected = selectFairDispatchCandidateRows({
            expandedRows: [],
            headRows: heads,
            limit: freeSlots,
            ...(cursor === undefined ? {} : { repositoryCursor: cursor }),
          });
          if (selected === null) {
            throw new Error(`Capacity selection rejected ${freeSlots.toString()} free slots`);
          }
          for (const row of selected) {
            if (seen.has(row.repositoryId)) {
              throw new Error(
                `Capacity selection repeated repository ${row.repositoryId}`,
              );
            }
            seen.add(row.repositoryId);
          }
          cursor = selected.at(-1)?.repositoryId;
        }
        if (seen.size !== heads.length) {
          throw new Error(
            `Capacity selection covered ${seen.size.toString()} of ${heads.length.toString()} repositories`,
          );
        }
      },
    ), { interruptAfterTimeLimit: 20_000 });
  }, 30_000);

  test("cursor wrap drains multiple rows per repository without starving a head", () => {
    assertProperty(fc.property(
      fc.integer({ min: 1, max: 32 }),
      fc.integer({ min: 2, max: 4 }),
      fc.integer({ min: 1, max: 4 }),
      (repositoryCount, rowsPerRepository, freeSlots) => {
        let remaining = Array.from(
          { length: repositoryCount * rowsPerRepository },
          (_, index) => {
            const repository = index % repositoryCount;
            const depth = Math.floor(index / repositoryCount);
            return {
              publicId: `run_wrap_${repository.toString().padStart(3, "0")}_${depth}`,
              queuedAt: depth * repositoryCount + repository,
              repositoryId: `repository_${repository.toString().padStart(3, "0")}`,
            };
          },
        );
        const seen = new Set<string>();
        let cursor: string | undefined;
        while (remaining.length > 0) {
          const headByRepository = new Map<string, (typeof remaining)[number]>();
          for (const row of remaining) {
            if (!headByRepository.has(row.repositoryId)) {
              headByRepository.set(row.repositoryId, row);
            }
          }
          const selected = selectFairDispatchCandidateRows({
            expandedRows: remaining,
            headRows: [...headByRepository.values()],
            limit: freeSlots,
            ...(cursor === undefined ? {} : { repositoryCursor: cursor }),
          });
          expect(selected).not.toBeNull();
          expect(selected?.length).toBeGreaterThan(0);
          const selectedIds = new Set(selected?.map(({ publicId }) => publicId) ?? []);
          for (const row of selected ?? []) {
            expect(seen.has(row.publicId)).toBeFalse();
            seen.add(row.publicId);
          }
          const selectedRepositories = [...new Set(
            selected?.map(({ repositoryId }) => repositoryId) ?? [],
          )];
          cursor = selectedRepositories.at(-1);
          remaining = remaining.filter(({ publicId }) => !selectedIds.has(publicId));
        }
        expect(seen.size).toBe(repositoryCount * rowsPerRepository);
      },
    ));
  });

  test("one repository fills every spare claim slot behind its stable head", () => {
    assertProperty(fc.property(
      fc.integer({ min: 1, max: 32 }),
      fc.integer({ min: 1, max: 4 }),
      (rowCount, freeSlots) => {
        const rows = Array.from({ length: rowCount }, (_, index) => ({
          publicId: `run_single_${index.toString().padStart(2, "0")}`,
          queuedAt: index,
          repositoryId: "repository_single",
        }));
        expect(selectFairDispatchCandidateRows({
          expandedRows: rows,
          headRows: rows.slice(0, 1),
          limit: freeSlots,
          repositoryCursor: "repository_single",
        }))
          .toEqual(rows.slice(0, Math.min(rowCount, freeSlots)));
      },
    ));
  });

  test("candidate eligibility is exactly the persisted wake and revision fence", () => {
    assertProperty(fc.property(
      fc.boolean(),
      fc.boolean(),
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: 0, max: 1_000_000 }),
      (persistedReady, readyNow, queuedRevision, revision, queuedFence, fence) => {
        expect(dispatchCandidateIsEligible({
          currentClaimFence: fence,
          currentTaskRevision: revision,
          persistedReady,
          queuedClaimFence: queuedFence,
          queuedTaskRevision: queuedRevision,
          readyNow,
        })).toBe(
          persistedReady && readyNow && queuedRevision === revision && queuedFence === fence,
        );
      },
    ));
  });

  test("terminal release proofs are an ordered subset of exact retained IDs", () => {
    assertProperty(fc.property(
      fc.uniqueArray(fc.string({ minLength: 1, maxLength: 24 }), { maxLength: 32 }),
      fc.array(fc.constantFrom("submitted", "failed", "cancelled", "ambiguous", "running"), {
        minLength: 32,
        maxLength: 32,
      }),
      (retained, phases) => {
        const rows = retained.map((publicId, index) => ({
          publicId,
          phase: phases[index] ?? "running",
        }));
        const result = retainedTerminalRunIds(retained, rows);
        expect(result).toEqual(retained.filter((runId) => {
          const phase = rows.find(({ publicId }) => publicId === runId)?.phase;
          return phase === "submitted" || phase === "failed" || phase === "cancelled";
        }));
      },
    ));
  });

  test("any semantic change invalidates an immutable execution revision", () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 1_000 }),
        (inputRevision, changes) => {
          expect(dispatchSubmissionInputRevisionMatches(inputRevision, inputRevision)).toBeTrue();
          expect(
            dispatchSubmissionInputRevisionMatches(inputRevision + changes, inputRevision),
          ).toBeFalse();
        },
      ),
    );
  });
  test("arbitrary lifecycle sequences cannot overflow the bounded run view", () => {
    assertProperty(
      fc.property(
        fc.integer({ min: -10, max: 130 }),
        fc.constantFrom(...publicRunEventKindSchema.options),
        (sequence, kind) => {
          const terminal = kind === "run.submitted" ||
            kind === "run.failed" ||
            kind === "run.cancelled" ||
            kind === "run.lease_lost";
          expect(runEventSequenceAllowed(sequence, kind)).toBe(
            Number.isSafeInteger(sequence) &&
              sequence > 0 &&
              sequence <= (terminal ? 100 : 96),
          );
        },
      ),
    );
  });
  test("every retained or renewed dispatch lease is positive and bounded by its task claim", () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 * 60 * 1_000 }),
        (now, generation, remaining) => {
          const disposition = dispatchClaimLeaseDisposition(
            {
              claimLeaseGeneration: generation,
              claimLeaseUntil: now + remaining,
            },
            now,
          );
          expect(disposition).not.toBeNull();
          if (disposition === null) return;
          expect(disposition.dispatchLeaseUntil).toBeGreaterThan(now);
          expect(disposition.dispatchLeaseUntil).toBeLessThanOrEqual(
            disposition.claimLeaseUntil,
          );
          expect(disposition.claimLeaseGeneration).toBe(
            remaining <= 5 * 60 * 1_000 ? generation + 1 : generation,
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  test("only an exact current heartbeat tuple can replay", () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.boolean(),
        (generation, sequence, changeFingerprint) => {
          const current = {
            bootId: "boot_current",
            bootGeneration: generation,
            heartbeatSequence: sequence,
            heartbeatFingerprint: "fingerprint_current",
            leaseUntil: 10_000,
          };
          const result = heartbeatDisposition(current, {
            bootId: "boot_current",
            bootGeneration: generation,
            sequence,
            fingerprint: changeFingerprint ? "fingerprint_changed" : "fingerprint_current",
          });
          expect(result.kind).toBe(changeFingerprint ? "conflict" : "replay");
        },
      ),
      { numRuns: 500 },
    );
  });

  test("a different installation cannot take workspace authority before the exact lease boundary", () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 45_000 }),
        fc.integer({ min: 1, max: 1_000_000 }),
        (now, remaining, generation) => {
          const current = {
            runnerPublicId: "runner_primary",
            installationId: "install_primary",
            generation,
            leaseUntil: now + remaining,
          };
          const contender = {
            runnerPublicId: "runner_contender",
            installationId: "install_contender",
          };
          expect(runnerAuthorityDisposition(current, contender, now)).toEqual({
            kind: "conflict",
            retryAfterMs: remaining,
          });
          expect(
            runnerAuthorityDisposition(current, contender, current.leaseUntil),
          ).toEqual({ kind: "takeover", generation: generation + 1 });
        },
      ),
      { numRuns: 500 },
    );
  });

  test("authority clock validity is equivalent to a positive generation and exact safe lease", () => {
    assertProperty(fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.integer({ min: 0, max: 10_000_000 }),
      fc.integer({ min: -1, max: 1 }),
      (generation, leaseUntil, delta) => {
        expect(runnerAuthorityClockMatches({
          authorityGeneration: generation,
          authorityLeaseUntil: leaseUntil,
          runnerLeaseUntil: leaseUntil + delta,
        })).toBe(delta === 0);
      },
    ));
  });

  test("any single completion binding corruption fences a dispatch submission", () => {
    assertProperty(
      fc.property(fc.integer({ min: 0, max: 10 }), (corruption) => {
        const exact = {
          now: 1_000,
          authorization: { organizationId: "org_a", workspaceId: "workspace_a", agentId: "agent_a" },
          request: {
            runId: "run_a",
            runnerId: "runner_a",
            bootId: "boot_a",
            claimId: "claim_a",
            claimFence: 7,
          },
          task: { id: "task_a", organizationId: "org_a", workspaceId: "workspace_a" },
          claim: {
            id: "claim_row_a",
            organizationId: "org_a",
            workspaceId: "workspace_a",
            taskId: "task_a",
            agentId: "agent_a",
            publicId: "claim_a",
            fence: 7,
            state: "active",
            leaseUntil: 3_000,
          },
          dispatch: {
            publicId: "run_a",
            organizationId: "org_a",
            workspaceId: "workspace_a",
            taskId: "task_a",
            runnerId: "runner_row_a",
            runnerPublicId: "runner_a",
            bootId: "boot_a",
            bootGeneration: 3,
            taskClaimId: "claim_row_a",
            taskClaimPublicId: "claim_a",
            claimFence: 7,
            leaseUntil: 2_000,
            phase: "running" as const,
          },
          runner: {
            id: "runner_row_a",
            organizationId: "org_a",
            workspaceId: "workspace_a",
            agentId: "agent_a",
            publicId: "runner_a",
            installationId: "install_a",
            bootId: "boot_a",
            bootGeneration: 3,
            leaseUntil: 2_500,
          },
          authority: {
            organizationId: "org_a",
            workspaceId: "workspace_a",
            runnerId: "runner_row_a",
            runnerPublicId: "runner_a",
            installationId: "install_a",
            generation: 2,
            leaseUntil: 2_500,
          },
        };
        expect(dispatchSubmissionAuthorityMatches(exact)).toBeTrue();
        let corruptedMatches: boolean;
        switch (corruption) {
          case 0:
            corruptedMatches = dispatchSubmissionAuthorityMatches({
              ...exact,
              request: { ...exact.request, runId: "run_b" },
            });
            break;
          case 1:
            corruptedMatches = dispatchSubmissionAuthorityMatches({
              ...exact,
              request: { ...exact.request, runnerId: "runner_b" },
            });
            break;
          case 2:
            corruptedMatches = dispatchSubmissionAuthorityMatches({
              ...exact,
              request: { ...exact.request, bootId: "boot_b" },
            });
            break;
          case 3:
            corruptedMatches = dispatchSubmissionAuthorityMatches({
              ...exact,
              request: { ...exact.request, claimId: "claim_b" },
            });
            break;
          case 4:
            corruptedMatches = dispatchSubmissionAuthorityMatches({
              ...exact,
              request: { ...exact.request, claimFence: exact.request.claimFence + 1 },
            });
            break;
          case 5:
            corruptedMatches = dispatchSubmissionAuthorityMatches({
              ...exact,
              authority: { ...exact.authority, runnerId: "runner_row_b" },
            });
            break;
          case 6:
            corruptedMatches = dispatchSubmissionAuthorityMatches({
              ...exact,
              authority: { ...exact.authority, installationId: "install_b" },
            });
            break;
          case 7:
            corruptedMatches = dispatchSubmissionAuthorityMatches({
              ...exact,
              authority: { ...exact.authority, leaseUntil: exact.authority.leaseUntil + 1 },
            });
            break;
          case 8:
            corruptedMatches = dispatchSubmissionAuthorityMatches({
              ...exact,
              dispatch: { ...exact.dispatch, taskId: "task_b" },
            });
            break;
          case 9:
            corruptedMatches = dispatchSubmissionAuthorityMatches({
              ...exact,
              claim: { ...exact.claim, state: "submitted" },
            });
            break;
          case 10:
            corruptedMatches = dispatchSubmissionAuthorityMatches({
              ...exact,
              dispatch: { ...exact.dispatch, phase: "failed" },
            });
            break;
          default:
            throw new Error("unreachable completion corruption selector");
        }
        expect(corruptedMatches).toBeFalse();
      }),
      { numRuns: 250 },
    );
  });

  test("any single tenant-coordinate corruption fails closed", () => {
    const fields = [
      "runnerOrganizationId",
      "runnerWorkspaceId",
      "taskOrganizationId",
      "taskWorkspaceId",
      "repositoryOrganizationId",
      "repositoryWorkspaceId",
      "dispatchOrganizationId",
      "dispatchWorkspaceId",
    ] as const;
    assertProperty(
      fc.property(fc.integer({ min: 0, max: fields.length - 1 }), (fieldIndex) => {
        const tuple = {
          authorizedOrganizationId: "org_a",
          authorizedWorkspaceId: "ws_a",
          runnerOrganizationId: "org_a",
          runnerWorkspaceId: "ws_a",
          taskOrganizationId: "org_a",
          taskWorkspaceId: "ws_a",
          repositoryOrganizationId: "org_a",
          repositoryWorkspaceId: "ws_a",
          dispatchOrganizationId: "org_a",
          dispatchWorkspaceId: "ws_a",
        };
        const field = fields[fieldIndex];
        expect(field).toBeDefined();
        if (field === undefined) return;
        const corrupted = {
          ...tuple,
          [field]: field.endsWith("OrganizationId") ? "org_foreign" : "ws_foreign",
        };
        expect(dispatchTenantTupleMatches(tuple)).toBeTrue();
        expect(dispatchTenantTupleMatches(corrupted)).toBeFalse();
      }),
      { numRuns: 250 },
    );
  });

  test("any runner, boot, generation, claim, or fence mismatch invalidates a binding", () => {
    const fields = [
      "runnerId",
      "bootId",
      "bootGeneration",
      "claimPublicId",
      "claimFence",
    ] as const;
    assertProperty(
      fc.property(fc.integer({ min: 0, max: fields.length - 1 }), (fieldIndex) => {
        const expected = {
          dispatchRunnerId: "runner_a",
          runnerId: "runner_a",
          dispatchBootId: "boot_a",
          bootId: "boot_a",
          dispatchBootGeneration: 4,
          bootGeneration: 4,
          dispatchClaimPublicId: "claim_a",
          claimPublicId: "claim_a",
          dispatchClaimFence: 9,
          claimFence: 9,
        };
        const field = fields[fieldIndex];
        expect(field).toBeDefined();
        if (field === undefined) return;
        const corrupted = { ...expected };
        switch (field) {
          case "runnerId":
            corrupted.runnerId = "runner_b";
            break;
          case "bootId":
            corrupted.bootId = "boot_b";
            break;
          case "bootGeneration":
            corrupted.bootGeneration += 1;
            break;
          case "claimPublicId":
            corrupted.claimPublicId = "claim_b";
            break;
          case "claimFence":
            corrupted.claimFence += 1;
            break;
        }
        expect(dispatchBindingTupleMatches(expected)).toBeTrue();
        expect(dispatchBindingTupleMatches(corrupted)).toBeFalse();
      }),
      { numRuns: 250 },
    );
  });

  test("arbitrary contiguous replay-prefix plus one new suffix is admitted", () => {
    assertProperty(
      fc.property(
        fc.integer({ min: 1, max: 1_000 }),
        fc.integer({ min: 0, max: 20 }),
        (acceptedThrough, replayLength) => {
          const start = Math.max(1, acceptedThrough - replayLength + 1);
          const events = Array.from(
            { length: acceptedThrough - start + 2 },
            (_, index) => ({
              id: `event_${start + index}`,
              sequence: start + index,
              kind: "codex.testing",
            }),
          );
          expect(
            contiguousEventBatch({ acceptedThroughSequence: acceptedThrough, events }),
          ).toBeTrue();
          const gapped = [{ id: "event_gap", sequence: acceptedThrough + 2, kind: "codex.testing" }];
          expect(
            contiguousEventBatch({ acceptedThroughSequence: acceptedThrough, events: gapped }),
          ).toBeFalse();
        },
      ),
      { numRuns: 500 },
    );
  });

  test("display replay equality is reflexive and detects every changed text payload", () => {
    assertProperty(fc.property(
      fc.constantFrom(
        "codex.reasoning_summary.delta" as const,
        "codex.assistant_message.delta" as const,
      ),
      fc.string({ minLength: 1, maxLength: 200 }),
      fc.string({ minLength: 1, maxLength: 200 }),
      (kind, displayText, replacement) => {
        const event = { id: "event_property001", sequence: 1, kind, displayText };
        expect(storedRunEventPayloadMatches(event, event)).toBeTrue();
        expect(storedRunEventPayloadMatches({ ...event, displayText: replacement }, event))
          .toBe(replacement === displayText);
      },
    ), { numRuns: 500 });
  });

  test("stored replay identity rejects every cross-kind substitution", () => {
    assertProperty(fc.property(
      fc.string({ minLength: 1, maxLength: 200 }),
      fc.boolean(),
      (displayText, textEvent) => {
        if (textEvent) {
          const incoming = {
            id: "event_property001",
            sequence: 1,
            kind: "codex.assistant_message.delta" as const,
            displayText,
          };
          expect(storedRunEventPayloadMatches({
            kind: "codex.reasoning_summary.delta",
            displayText,
          }, incoming)).toBeFalse();
          return;
        }
        expect(storedRunEventPayloadMatches(
          { kind: "codex.testing" },
          { id: "event_property001", sequence: 1, kind: "codex.running" },
        )).toBeFalse();
      },
    ), { numRuns: 500 });
  });

  test("arbitrary bounded histories charge new suffixes but never exact replay prefixes", () => {
    assertProperty(fc.property(
      fc.integer({ min: 0, max: MAX_RUN_REASONING_SUMMARY_EVENTS }),
      fc.integer({ min: 0, max: MAX_RUN_TOOL_ACTIVITY_EVENTS }),
      fc.integer({ min: 0, max: MAX_RUN_DISPLAY_EVENTS }),
      fc.integer({ min: 0, max: 25 }),
      (reasoningCount, rawToolCount, rawAssistantCount, rawReplayCount) => {
        const toolCount = rawToolCount - rawToolCount % 2;
        const assistantCount = rawAssistantCount %
          (MAX_RUN_DISPLAY_EVENTS - reasoningCount - toolCount + 1);
        const kinds = [
          ...Array.from({ length: reasoningCount }, () => (
            "codex.reasoning_summary.delta" as const
          )),
          ...Array.from({ length: toolCount }, (_, index) => index % 2 === 0
            ? "codex.tool_activity.started" as const
            : "codex.tool_activity.completed" as const),
          ...Array.from({ length: assistantCount }, () => (
            "codex.assistant_message.delta" as const
          )),
        ];
        const existingEvents = kinds.map((kind, index) => ({ sequence: index + 1, kind }));
        const replayCount = Math.min(rawReplayCount, existingEvents.length);
        const replay = existingEvents.slice(existingEvents.length - replayCount);
        expect(runDisplayBudgetAfterBatch({
          acceptedThroughSequence: existingEvents.length,
          existingEvents,
          events: replay,
        })).toEqual({
          kind: "accepted",
          budget: {
            displayEvents: kinds.length,
            reasoningSummaryEvents: reasoningCount,
            toolActivityEvents: toolCount,
          },
        });
      },
    ), { numRuns: 1_000 });
  });

  test("every active phase expires only at its exact scheduled deadline", () => {
    const activePhase = fc.constantFrom<RunPhase>(
      "leased",
      "provisioning",
      "starting",
      "running",
      "waiting",
      "cancel_requested",
    );
    assertProperty(
      fc.property(
        activePhase,
        fc.integer({ min: 1, max: 1_000_000_000 }),
        fc.integer({ min: 1, max: 90_000 }),
        (phase, now, remaining) => {
          const current = {
            dispatchId: "dispatch_a",
            runnerId: "runner_a",
            bootId: "boot_a",
            bootGeneration: 4,
            taskClaimId: "claim_a",
            claimFence: 9,
            leaseGeneration: 7,
            leaseUntil: now + remaining,
            phase,
          };
          const scheduled = {
            dispatchId: current.dispatchId,
            runnerId: current.runnerId,
            bootId: current.bootId,
            bootGeneration: current.bootGeneration,
            taskClaimId: current.taskClaimId,
            claimFence: current.claimFence,
            leaseGeneration: current.leaseGeneration,
            expectedDeadline: current.leaseUntil,
          };
          expect(scheduledDispatchExpiryDisposition(current, scheduled, now)).toBe("reschedule");
          expect(
            scheduledDispatchExpiryDisposition(current, scheduled, current.leaseUntil),
          ).toBe(phase === "leased" ? "requeue" : "ambiguous");
        },
      ),
      { numRuns: 500 },
    );
  });

  test("any single dispatch lease binding corruption makes expiry stale", () => {
    const fields = [
      "dispatchId",
      "runnerId",
      "bootId",
      "bootGeneration",
      "taskClaimId",
      "claimFence",
      "leaseGeneration",
      "expectedDeadline",
    ] as const;
    assertProperty(
      fc.property(fc.integer({ min: 0, max: fields.length - 1 }), (fieldIndex) => {
        const current = {
          dispatchId: "dispatch_a",
          runnerId: "runner_a",
          bootId: "boot_a",
          bootGeneration: 4,
          taskClaimId: "claim_a",
          claimFence: 9,
          leaseGeneration: 7,
          leaseUntil: 50_000,
          phase: "running" as const,
        };
        const scheduled = {
          dispatchId: current.dispatchId,
          runnerId: current.runnerId,
          bootId: current.bootId,
          bootGeneration: current.bootGeneration,
          taskClaimId: current.taskClaimId,
          claimFence: current.claimFence,
          leaseGeneration: current.leaseGeneration,
          expectedDeadline: current.leaseUntil,
        };
        const field = fields[fieldIndex];
        expect(field).toBeDefined();
        if (field === undefined) return;
        const corrupted = { ...scheduled };
        switch (field) {
          case "dispatchId":
            corrupted.dispatchId = "dispatch_b";
            break;
          case "runnerId":
            corrupted.runnerId = "runner_b";
            break;
          case "bootId":
            corrupted.bootId = "boot_b";
            break;
          case "bootGeneration":
            corrupted.bootGeneration += 1;
            break;
          case "taskClaimId":
            corrupted.taskClaimId = "claim_b";
            break;
          case "claimFence":
            corrupted.claimFence += 1;
            break;
          case "leaseGeneration":
            corrupted.leaseGeneration += 1;
            break;
          case "expectedDeadline":
            corrupted.expectedDeadline += 1;
            break;
        }
        expect(scheduledDispatchExpiryDisposition(current, corrupted, current.leaseUntil)).toBe(
          "stale",
        );
      }),
      { numRuns: 500 },
    );
  });

  test("the task-release policy is total over every run phase", () => {
    const phases = [
      "queued",
      "leased",
      "provisioning",
      "starting",
      "running",
      "waiting",
      "submitted",
      "failed",
      "cancel_requested",
      "cancelled",
      "ambiguous",
    ] as const satisfies readonly RunPhase[];
    assertProperty(
      fc.property(fc.constantFrom<RunPhase>(...phases), (phase) => {
        const provedTerminal = phase === "submitted" || phase === "failed" || phase === "cancelled";
        expect(taskDispatchBlocksTaskRelease(phase)).toBe(!provedTerminal);
      }),
      { numRuns: 500 },
    );
  });

  test("no active, unreviewed submitted, or ambiguous attempt is retryable", () => {
    const forbidden = fc.constantFrom<RunPhase>(
      "queued",
      "leased",
      "provisioning",
      "starting",
      "running",
      "waiting",
      "submitted",
      "cancel_requested",
      "ambiguous",
    );
    assertProperty(
      fc.property(forbidden, fc.integer({ min: 1, max: 10_000 }), (sourcePhase, revision) => {
        expect(
          dispatchRetryAllowed({
            sourcePhase,
            sourceSubmissionRejected: false,
            taskRevision: revision,
            expectedTaskRevision: revision,
            taskStatus: "open",
            taskHasCurrentClaim: false,
            sourceFenceMatches: true,
            anotherDispatchBlocksTask: false,
            sourceAlreadyRetried: false,
          }),
        ).toBeFalse();
      }),
      { numRuns: 500 },
    );
  });

  test("submission rejection proof is exact over status and dispatch identity", () => {
    assertProperty(
      fc.property(
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.string({ minLength: 1, maxLength: 64 }),
        fc.constantFrom("accepted", "cancelled", "pending", "rejected"),
        (sourceDispatchPublicId, submissionDispatchPublicId, submissionStatus) => {
          expect(rejectedSubmissionMatchesDispatch({
            sourceDispatchPublicId,
            submissionDispatchPublicId,
            submissionStatus,
          })).toBe(
            submissionStatus === "rejected" &&
              submissionDispatchPublicId === sourceDispatchPublicId,
          );
        },
      ),
      { numRuns: 1_000 },
    );
  });

  test("any stale retry or ambiguity-resolution coordinate fails closed", () => {
    const retryFields = [
      "revision",
      "status",
      "claim",
      "fence",
      "blocking",
      "retried",
    ] as const;
    assertProperty(
      fc.property(fc.constantFrom(...retryFields), (field) => {
        const retry = {
          sourcePhase: "failed" as const,
          sourceSubmissionRejected: false,
          taskRevision: 4,
          expectedTaskRevision: 4,
          taskStatus: "open" as const,
          taskHasCurrentClaim: false,
          sourceFenceMatches: true,
          anotherDispatchBlocksTask: false,
          sourceAlreadyRetried: false,
        };
        const resolution = {
          sourcePhase: "ambiguous" as const,
          taskRevision: 4,
          expectedTaskRevision: 4,
          taskStatus: "in_progress" as const,
          taskHasCurrentClaim: true,
          sourceFenceMatches: true,
          anotherDispatchBlocksTask: false,
        };
        switch (field) {
          case "revision":
            retry.taskRevision += 1;
            resolution.taskRevision += 1;
            break;
          case "status":
            Object.assign(retry, { taskStatus: "done" as const });
            Object.assign(resolution, { taskStatus: "open" as const });
            break;
          case "claim":
            retry.taskHasCurrentClaim = true;
            resolution.taskHasCurrentClaim = false;
            break;
          case "fence":
            retry.sourceFenceMatches = false;
            resolution.sourceFenceMatches = false;
            break;
          case "blocking":
            retry.anotherDispatchBlocksTask = true;
            resolution.anotherDispatchBlocksTask = true;
            break;
          case "retried":
            retry.sourceAlreadyRetried = true;
            resolution.taskRevision += 1;
            break;
        }
        expect(dispatchRetryAllowed(retry)).toBeFalse();
        expect(
          resolvedAmbiguousDispatchPhase(resolution, "confirmed_cancelled"),
        ).toBeNull();
      }),
      { numRuns: 500 },
    );
  });
});
