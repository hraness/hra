import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  MAX_TASK_HUMAN_INPUT_PREVIEW_UTF8_BYTES,
  absoluteHttpsUrlSchema,
  createWorkspaceRepositoryRequestSchema,
  submitTaskRequestSchema,
  taskReferenceInputSchema,
  taskHumanInputViewSchema,
  taskSubmissionViewSchema,
} from "./index";

test("human-input preview obeys UTF-8 and control bounds for arbitrary text", () => {
  assertProperty(fc.property(fc.string(), (preview) => {
    const bytes = new TextEncoder().encode(preview).length;
    const forbidden = [...preview].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (codePoint <= 31 && ![9, 10, 13].includes(codePoint)) || codePoint === 127;
    });
    const value = {
      pendingCount: 1,
      oldestRequestedAt: 1,
      expiresAt: 2,
      kind: "user_input",
      preview,
    };
    expect(taskHumanInputViewSchema.safeParse(value).success).toBe(
      preview.trim().length > 0 &&
      bytes <= MAX_TASK_HUMAN_INPUT_PREVIEW_UTF8_BYTES &&
      !forbidden,
    );
  }));
});

test("arbitrary task reference and evidence values never make strict parsers throw", () => {
  assertProperty(
    fc.property(fc.jsonValue(), (value) => {
      expect(() => taskReferenceInputSchema.safeParse(value)).not.toThrow();
      expect(() => submitTaskRequestSchema.safeParse(value)).not.toThrow();
      expect(() => taskSubmissionViewSchema.safeParse(value)).not.toThrow();
    }),
  );
});

test("credential-bearing HTTPS URLs are rejected at every reference boundary", () => {
  const credentialComponent = fc
    .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), {
      minLength: 1,
      maxLength: 40,
    })
    .map((characters) => characters.join(""));
  assertProperty(
    fc.property(credentialComponent, credentialComponent, (username, password) => {
      const url = `https://${username}:${password}@example.com/resource`;
      expect(absoluteHttpsUrlSchema.safeParse(url).success).toBeFalse();
      expect(taskReferenceInputSchema.safeParse({ kind: "pull_request", url }).success).toBeFalse();
      expect(
        createWorkspaceRepositoryRequestSchema.safeParse({
          workspaceId: "workspace-id",
          name: "repository",
          provider: "github",
          url,
        }).success,
      ).toBeFalse();
      expect(
        submitTaskRequestSchema.safeParse({
          fence: 1,
          summary: "done",
          evidence: [{ kind: "pull_request", url }],
        }).success,
      ).toBeFalse();
    }),
  );
});

test("adding any unknown evidence field is rejected", () => {
  assertProperty(
    fc.property(fc.string({ minLength: 1, maxLength: 200 }), (text) => {
      const value = {
        fence: 1,
        summary: "done",
        evidence: [{ kind: "note", text, credential: "forbidden" }],
      };
      expect(submitTaskRequestSchema.safeParse(value).success).toBeFalse();
    }),
  );
});

test("dispatch-bound submissions require one identical claim fence", () => {
  assertProperty(
    fc.property(
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.integer({ min: 1, max: 1_000_000 }),
      (taskFence, dispatchFence) => {
        const parsed = submitTaskRequestSchema.safeParse({
          fence: taskFence,
          expectedReviewRevision: 1,
          dispatch: {
            runId: "run_primary0001",
            runnerId: "runner_primary0001",
            bootId: "boot_primary0001",
            claimId: "claim_primary001",
            claimFence: dispatchFence,
          },
          summary: "done",
          evidence: [{ kind: "note", text: "done" }],
        });
        expect(parsed.success).toBe(taskFence === dispatchFence);
      },
    ),
    { numRuns: 500 },
  );
});
