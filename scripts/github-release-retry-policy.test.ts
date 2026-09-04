import { describe, expect, test } from "bun:test";

import {
  classifyCreatedDraftInventory,
  classifyLaterAttemptDraftInventory,
  classifyPublishedDraftInventory,
  parseReleaseInventoryPage,
  priorAttemptProvesNoDraftCreation,
} from "./github-release-retry-policy";

const tag = "v0.5.0";
const commitSha = "1".repeat(40);

describe("bounded GitHub Release retry policy", () => {
  test("accepts only projected, bounded, exhaustively pageable inventory", () => {
    expect(parseReleaseInventoryPage([
      { draft: false, id: 1, tag_name: tag },
      { draft: true, id: 2, tag_name: "v0.0.9" },
      { draft: true, id: 3, tag_name: tag },
    ], tag)).toEqual({ candidateIds: [3], complete: true });
    expect(parseReleaseInventoryPage(Array.from({ length: 100 }, (_, index) => ({
      draft: false,
      id: index + 1,
      tag_name: `v0.0.${String(index)}`,
    })), tag).complete).toBe(false);
    expect(() => parseReleaseInventoryPage([
      { draft: true, id: 3, tag_name: tag, unprojected: true },
    ], tag)).toThrow("unexpected fields");
  });

  test("admits only exact created and published inventory convergence", () => {
    expect(classifyCreatedDraftInventory([], 901)).toBe("pending");
    expect(classifyCreatedDraftInventory([901], 901)).toBe("exact");
    expect(() => classifyCreatedDraftInventory([902], 901)).toThrow("not uniquely identified");
    expect(() => classifyCreatedDraftInventory([901, 902], 901)).toThrow("not uniquely identified");
    expect(() => classifyCreatedDraftInventory([901, 901], 901)).toThrow("duplicate identifiers");

    expect(classifyPublishedDraftInventory([901], 901)).toBe("pending");
    expect(classifyPublishedDraftInventory([], 901)).toBe("exact");
    expect(() => classifyPublishedDraftInventory([902], 901)).toThrow("ambiguous residual draft");
    expect(classifyLaterAttemptDraftInventory([])).toEqual({ state: "pending" });
    expect(classifyLaterAttemptDraftInventory([901])).toEqual({ draftId: 901, state: "recover" });
    expect(() => classifyLaterAttemptDraftInventory([901, 902])).toThrow("ambiguous residual drafts");
  });

  test("proves creation safety only when the prior publication step never ran", () => {
    const runId = "70000000001";
    const input = { attempt: 1, commitSha, runId };
    const job = (
      conclusion: string,
      publicationConclusion: string | undefined,
      overrides: Readonly<Record<string, unknown>> = {},
    ) => ({
      conclusion,
      head_sha: commitSha,
      id: 901,
      name: "Publish exact npm and GitHub artifacts",
      run_attempt: 1,
      run_id: Number(runId),
      run_url: `https://api.github.com/repos/hraness/hra/actions/runs/${runId}`,
      status: "completed",
      steps: publicationConclusion === undefined ? [] : [{
        conclusion: publicationConclusion,
        name: "Create immutable GitHub Release from the same bytes",
        status: "completed",
      }],
      workflow_name: "Release",
      ...overrides,
    });
    const response = (writer: unknown, extra: readonly unknown[] = []) => ({
      jobs: [writer, ...extra],
      total_count: 1 + extra.length,
    });

    expect(priorAttemptProvesNoDraftCreation(response(job("skipped", undefined)), input)).toBe(true);
    for (const conclusion of ["failure", "cancelled", "timed_out"]) {
      expect(priorAttemptProvesNoDraftCreation(response(job(conclusion, "skipped")), input)).toBe(true);
    }
    expect(priorAttemptProvesNoDraftCreation(response(job("failure", "failure")), input)).toBe(false);
    expect(priorAttemptProvesNoDraftCreation(response(job("success", "skipped")), input)).toBe(false);
    expect(() => priorAttemptProvesNoDraftCreation(
      response(job("skipped", undefined, { head_sha: "f".repeat(40) })),
      input,
    )).toThrow("malformed");
    expect(() => priorAttemptProvesNoDraftCreation(
      response(job("skipped", undefined), [job("skipped", undefined, { id: 902 })]),
      input,
    )).toThrow("one exact Release writer job");
    expect(() => priorAttemptProvesNoDraftCreation(
      { jobs: [job("skipped", undefined)], total_count: 2 },
      input,
    )).toThrow("count is inconsistent");
  });
});
