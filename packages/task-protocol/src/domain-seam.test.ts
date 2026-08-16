import { describe, expect, test } from "bun:test";
import * as domain from "@hraness/agent-tasks-domain";

import * as protocol from "./index";

describe("task protocol domain seam", () => {
  test("re-exports one authoritative portable model and identifier implementation", () => {
    for (const name of [
      "repositoryIdSchema",
      "taskReferenceIdSchema",
      "taskCommentIdSchema",
      "taskSubmissionIdSchema",
      "taskStatusSchema",
      "taskTypeSchema",
      "taskViewSchema",
      "readyTaskViewSchema",
      "dispatchIdSchema",
      "dispatchClaimIdSchema",
      "dispatchEventIdSchema",
      "publicRunEventSchema",
      "runPhaseSchema",
      "runEventViewSchema",
      "runInteractionIdSchema",
      "runInteractionQuestionIdSchema",
      "runInteractionOptionIdSchema",
    ] as const) {
      expect(protocol[name]).toBe(domain[name]);
    }
    expect(protocol.runInteractionOptionSchema)
      .toBe(domain.portableRunInteractionOptionSchema);
    expect(protocol.runInteractionQuestionSchema)
      .toBe(domain.portableRunInteractionQuestionSchema);
    expect(protocol.runInteractionRequestPayloadSchema)
      .toBe(domain.portableRunInteractionRequestSchema);
    expect(protocol.runInteractionResponseSchema)
      .toBe(domain.portableRunInteractionResponseSchema);
  });

  test("retains cloud transport contracts outside the leaf domain", () => {
    for (const name of [
      "organizationIdSchema",
      "workspaceIdSchema",
      "taskIdSchema",
      "eventCommandSchema",
      "taskEventSchema",
    ]) {
      expect(name in protocol).toBeTrue();
      expect(name in domain).toBeFalse();
    }
    expect("credentialTokenSchema" in protocol).toBeTrue();
    expect("credentialTokenSchema" in domain).toBeFalse();
    expect("taskctlApiOperations" in protocol).toBeTrue();
    expect("taskctlApiOperations" in domain).toBeFalse();
    expect("interactionResponseAad" in protocol).toBeTrue();
    expect("interactionResponseAad" in domain).toBeFalse();
  });
});
