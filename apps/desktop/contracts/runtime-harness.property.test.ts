import { expect, test } from "bun:test";
import { assertProperty, fc } from "@hra-internal/test";

import {
  chatPaneHarnessProjectionSchema,
  harnessChildProjectionSchema,
  harnessDescendantsProjectionSchema,
  harnessSettingsProjectionSchema,
  harnessSnapshotSchema,
  parseRuntimeDispatchRequest,
  parseRuntimeHarnessDispatchResponseForRequest,
  runtimeProtocolVersion,
  type RuntimeHarnessDispatchRequest,
} from "./runtime";

const states = [
  "starting",
  "running",
  "waiting",
  "idle",
  "failed",
  "stopped",
  "quarantined",
] as const;

test("child stop authority is exactly persistent nonterminal lifecycle", () => {
  assertProperty(fc.property(
    fc.constantFrom(...states),
    fc.boolean(),
    (state, canStop) => {
      const accepted = harnessChildProjectionSchema.safeParse({
        id: "hactor_property0001",
        revision: 1,
        title: "Property child",
        state,
        openedPaneId: null,
        canOpen: false,
        canMessage: false,
        canStop,
      }).success;
      expect(accepted).toBe(
        canStop === (state !== "stopped" && state !== "quarantined"),
      );
    },
  ));
});

test("child open and message actions are exclusive, attachment-bound, and terminal-turn-only", () => {
  assertProperty(fc.property(
    fc.constantFrom(...states),
    fc.boolean(),
    fc.constantFrom("none" as const, "open" as const, "message" as const, "both" as const),
    (state, opened, mode) => {
      const canOpen = mode === "open" || mode === "both";
      const canMessage = mode === "message" || mode === "both";
      const accepted = harnessChildProjectionSchema.safeParse({
        id: "hactor_actionproperty01",
        revision: 1,
        title: "Action property child",
        state,
        openedPaneId: opened ? "pane_actionproperty01" : null,
        canOpen,
        canMessage,
        canStop: state !== "stopped" && state !== "quarantined",
      }).success;
      const actionableState = state === "idle" || state === "failed";
      const expected = mode === "none" || (
        mode === "open" && !opened && actionableState
      ) || (
        mode === "message" && opened && actionableState
      );
      expect(accepted).toBe(expected);
    },
  ));
});

test("context quota accepts only bounded whole MiB values", () => {
  assertProperty(fc.property(fc.integer({ min: -4, max: 70 }), (mib) => {
    const accepted = harnessSettingsProjectionSchema.safeParse({
      revision: 1,
      recursiveSessionsEnabled: true,
      contextQuotaBytes: mib * 1024 * 1024,
      refinementMode: "suggest",
    }).success;
    expect(accepted).toBe(mib >= 1 && mib <= 64);
  }));
});

test("descendant truncation exactly reports omitted bounded children", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 50 }),
    fc.integer({ min: 0, max: 10 }),
    fc.boolean(),
    (count, projectedCount, truncated) => {
      const children = Array.from({ length: projectedCount }, (_, index) => ({
        id: `hactor_property${String(index).padStart(4, "0")}`,
        revision: 1,
        title: `Property child ${String(index + 1)}`,
        state: "idle" as const,
        openedPaneId: null,
        canOpen: false,
        canMessage: false,
        canStop: true,
      }));
      const accepted = harnessDescendantsProjectionSchema.safeParse({
        count,
        truncated,
        children,
      }).success;
      expect(accepted).toBe(
        projectedCount >= 1 && projectedCount <= 8 &&
          count >= projectedCount && truncated === (count > projectedCount),
      );
    },
  ));
});

test("every harness projection layer rejects hidden authority fields", () => {
  assertProperty(fc.property(
    fc.constantFrom(
      "providerId",
      "threadId",
      "turnId",
      "path",
      "transcript",
      "heap",
      "program",
      "trial",
      "command",
      "toolOutput",
    ),
    fc.jsonValue(),
    (key, value) => {
      const settings = {
        revision: 1,
        recursiveSessionsEnabled: true,
        contextQuotaBytes: 8 * 1024 * 1024,
        refinementMode: "suggest" as const,
      };
      const proposal = {
        id: "hproposal_property0001",
        revision: 1,
        title: "Property proposal",
      };
      const child = {
        id: "hactor_property0001",
        revision: 1,
        title: "Property child",
        state: "idle" as const,
        openedPaneId: null,
        canOpen: false,
        canMessage: false,
        canStop: true,
      };
      const descendants = {
        count: 1,
        truncated: false,
        children: [child],
      };
      const harness = { revision: 1, settings, proposals: [proposal] };
      const pane = { revision: 1, descendants };

      expect(harnessSnapshotSchema.safeParse({ ...harness, [key]: value }).success)
        .toBeFalse();
      expect(harnessSnapshotSchema.safeParse({
        ...harness,
        settings: { ...settings, [key]: value },
      }).success).toBeFalse();
      expect(harnessSnapshotSchema.safeParse({
        ...harness,
        proposals: [{ ...proposal, [key]: value }],
      }).success).toBeFalse();
      expect(chatPaneHarnessProjectionSchema.safeParse({ ...pane, [key]: value }).success)
        .toBeFalse();
      expect(chatPaneHarnessProjectionSchema.safeParse({
        ...pane,
        descendants: { ...descendants, [key]: value },
      }).success).toBeFalse();
      expect(chatPaneHarnessProjectionSchema.safeParse({
        ...pane,
        descendants: {
          ...descendants,
          children: [{ ...child, [key]: value }],
        },
      }).success).toBeFalse();
    },
  ));
});

test("only the three explicit harness commands ever parse", () => {
  const accepted = [
    "harness.settings.update",
    "harness.child.open",
    "harness.child.stop",
  ] as const;
  const rejected = [
    "harness.candidate.review",
    "harness.candidate.decide",
    "harness.goal.stop",
    "harness.data.preview",
    "harness.data.delete",
    "harness.tree.stop",
    "harness.sync",
  ] as const;

  assertProperty(fc.property(fc.constantFrom(...accepted, ...rejected), (type) => {
    const command = type === "harness.settings.update" ? {
      type,
      expectedHarnessRevision: 1,
      expectedRevision: 1,
      recursiveSessionsEnabled: true,
      contextQuotaBytes: 1024 * 1024,
      refinementMode: "suggest",
    } : type === "harness.child.open" || type === "harness.child.stop" ? {
      type,
      parentPaneId: "pane_property000001",
      childId: "hactor_property0001",
      expectedParentRevision: 1,
      expectedChildRevision: 1,
    } : { type };
    let parsed = true;
    try {
      parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_harnessproperty1",
        command,
      });
    } catch {
      parsed = false;
    }
    expect(parsed).toBe((accepted as readonly string[]).includes(type));
  }));
});

test("child result correlation admits exactly one revision advance", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 1_000 }),
    fc.integer({ min: -2, max: 3 }),
    (revision, delta) => {
      const parentPaneId = "pane_property000001";
      const childId = "hactor_property0001";
      const request: RuntimeHarnessDispatchRequest = {
        version: runtimeProtocolVersion,
        operationId: "op_harnessrevision1",
        command: {
          type: "harness.child.stop",
          parentPaneId,
          childId,
          expectedParentRevision: revision,
          expectedChildRevision: revision,
        },
      };
      const response = {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "harnessChild",
          parentPaneId,
          parentRevision: revision + delta,
          child: {
            id: childId,
            revision: revision + delta,
            title: "Property child",
            state: "stopped",
            openedPaneId: null,
            canOpen: false,
            canMessage: false,
            canStop: false,
          },
        },
      };
      let accepted = true;
      try {
        parseRuntimeHarnessDispatchResponseForRequest(response, request);
      } catch {
        accepted = false;
      }
      expect(accepted).toBe(delta === 1);
    },
  ));
});

test("settings result correlation requires both revisions and every requested value", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 1_000 }),
    fc.integer({ min: -2, max: 3 }),
    fc.boolean(),
    (revision, delta, mutateValue) => {
      const request: RuntimeHarnessDispatchRequest = {
        version: runtimeProtocolVersion,
        operationId: "op_harnesssettingsproperty1",
        command: {
          type: "harness.settings.update",
          expectedHarnessRevision: revision,
          expectedRevision: revision,
          recursiveSessionsEnabled: true,
          contextQuotaBytes: 8 * 1024 * 1024,
          refinementMode: "suggest",
        },
      };
      const response = {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "harnessSettings",
          harnessRevision: revision + delta,
          settings: {
            revision: revision + delta,
            recursiveSessionsEnabled: mutateValue ? false : true,
            contextQuotaBytes: 8 * 1024 * 1024,
            refinementMode: "suggest",
          },
        },
      };
      let accepted = true;
      try {
        parseRuntimeHarnessDispatchResponseForRequest(response, request);
      } catch {
        accepted = false;
      }
      expect(accepted).toBe(delta === 1 && !mutateValue);
    },
  ));
});

test("child-open correlation requires both revision advances and the exact opened pane", () => {
  assertProperty(fc.property(
    fc.integer({ min: 1, max: 1_000 }),
    fc.integer({ min: -2, max: 3 }),
    fc.boolean(),
    (revision, delta, mismatchPane) => {
      const parentPaneId = "pane_parentproperty1";
      const childId = "hactor_property0001";
      const openedPaneId = "pane_openedproperty1";
      const request: RuntimeHarnessDispatchRequest = {
        version: runtimeProtocolVersion,
        operationId: "op_harnessopenproperty1",
        command: {
          type: "harness.child.open",
          parentPaneId,
          childId,
          expectedParentRevision: revision,
          expectedChildRevision: revision,
        },
      };
      const response = {
        version: runtimeProtocolVersion,
        operationId: request.operationId,
        ok: true,
        result: {
          type: "harnessChildOpened",
          parentPaneId,
          parentRevision: revision + delta,
          child: {
            id: childId,
            revision: revision + delta,
            title: "Property child",
            state: "idle",
            openedPaneId: mismatchPane ? "pane_otherproperty01" : openedPaneId,
            canOpen: false,
            canMessage: true,
            canStop: true,
          },
          pane: {
            id: openedPaneId,
            paletteIndex: 1,
            revision: 1,
            title: "Property child",
            repository: { id: "repo_00000000000000000000000000", name: "hra" },
            accountProfileId: null,
            interactionMode: "harnessObserver",
            state: "ready",
            activity: { ordinal: 0, kind: "idle" },
            workspace: null,
            turn: null,
            attention: null,
            recoverablePrompt: false,
            messageQueue: {
              revision: 1,
              pauseReason: null,
              blockedMessage: null,
              messages: [],
            },
            attachments: { drafts: [], referenced: [] },
            harness: null,
          },
        },
      };
      let accepted = true;
      try {
        parseRuntimeHarnessDispatchResponseForRequest(response, request);
      } catch {
        accepted = false;
      }
      expect(accepted).toBe(delta === 1 && !mismatchPane);
    },
  ));
});

test("commands reject arbitrary hidden authority fields", () => {
  assertProperty(fc.property(
    fc.constantFrom("providerId", "threadId", "path", "prompt", "program", "command"),
    fc.jsonValue(),
    (key, value) => {
      expect(() => parseRuntimeDispatchRequest({
        version: runtimeProtocolVersion,
        operationId: "op_harnessprivate1",
        command: {
          type: "harness.child.stop",
          parentPaneId: "pane_property000001",
          childId: "hactor_property0001",
          expectedParentRevision: 1,
          expectedChildRevision: 1,
          [key]: value,
        },
      })).toThrow();
    },
  ));
});
