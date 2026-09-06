import { describe, expect, test } from "bun:test";

import type { CompactRemoteInteractionQuestion } from "../hra/cloud";
import {
  buildInteractionAnswers,
  interactionAnswersAreComplete,
  interactionCommandAllowsRetry,
  remoteInteractionAnswerCharacters,
  type InteractionAnswerDraft,
  type InteractionAnswerDrafts,
} from "./interaction-panel";

const closedChoice: CompactRemoteInteractionQuestion = {
  allowsOther: false,
  header: "Region",
  id: "region",
  kind: "user_input",
  options: [
    { description: "Primary", label: "East" },
    { description: "Backup", label: "West" },
  ],
  question: "Which region should be used?",
};

describe("interaction answer contracts", () => {
  test("accepts only an exact projected closed-choice label", () => {
    expect(buildInteractionAnswers([closedChoice], {
      region: { mode: "option", value: "East" },
    })).toEqual({ region: { answers: ["East"] } });
    expect(buildInteractionAnswers([closedChoice], {
      region: { mode: "option", value: "North" },
    })).toBeNull();
    expect(buildInteractionAnswers([closedChoice], {})).toBeNull();
    expect(buildInteractionAnswers([], {})).toBeNull();
  });

  test("fails closed on legacy shapes and inherited drafts", () => {
    const legacyMcp = {
      id: "region",
      kind: "mcp_string",
      label: "region",
      maxLength: 10,
      minLength: 0,
      required: true,
    } as unknown as CompactRemoteInteractionQuestion;
    const legacyFreeText = {
      ...closedChoice,
      options: null,
    } as unknown as CompactRemoteInteractionQuestion;
    expect(buildInteractionAnswers([legacyMcp], {
      region: { mode: "option", value: "East" },
    })).toBeNull();
    expect(buildInteractionAnswers([legacyFreeText], {
      region: { mode: "option", value: "East" },
    })).toBeNull();

    const inherited = Object.create({
      region: { mode: "option", value: "East" },
    }) as Readonly<Record<string, { mode: "option"; value: string }>>;
    expect(buildInteractionAnswers([closedChoice], inherited)).toBeNull();
  });

  test("snapshots draft inputs without invoking or rereading accessors", () => {
    let reads = 0;
    const outerDrafts = Object.defineProperty({}, "region", {
      enumerable: true,
      get() {
        reads += 1;
        return { mode: "option", value: reads === 1 ? "East" : "West" };
      },
    }) as InteractionAnswerDrafts;
    expect(buildInteractionAnswers([closedChoice], outerDrafts)).toBeNull();
    expect(reads).toBe(0);

    const innerDraft = Object.defineProperties({}, {
      mode: {
        enumerable: true,
        get() {
          reads += 1;
          return "option";
        },
      },
      value: {
        enumerable: true,
        get() {
          reads += 1;
          return reads === 1 ? "East" : "West";
        },
      },
    });
    expect(buildInteractionAnswers([closedChoice], {
      region: innerDraft as InteractionAnswerDraft,
    })).toBeNull();
    expect(reads).toBe(0);
  });

  test("refuses a projected choice whose value is not remote safe", () => {
    for (const value of [
      `Use ${["", "Users", "operator", "private.txt"].join("/")}`,
      "hidden\u0000value",
      `ghp_${"x".repeat(24)}`,
    ]) {
      const question: CompactRemoteInteractionQuestion = {
        ...closedChoice,
        options: [{ description: "Unsafe", label: value }],
      };
      expect(buildInteractionAnswers([question], {
        region: { mode: "option", value },
      })).toBeNull();
    }
  });

  test("keeps user answers within the local UTF-16 resolution contract", () => {
    const value = "😀".repeat(10_000);
    const question: CompactRemoteInteractionQuestion = {
      ...closedChoice,
      options: [{ description: "Large", label: value }],
    };
    expect(buildInteractionAnswers([question], {
      region: { mode: "option", value },
    })).toBeNull();
  });

  test("refuses answer JSON beyond the provider aggregate byte bound", () => {
    const questions: CompactRemoteInteractionQuestion[] = Array.from(
      { length: 3 },
      (_, index) => ({
        ...closedChoice,
        id: `field${String(index)}`,
        options: [{ description: "Large", label: "é".repeat(remoteInteractionAnswerCharacters) }],
      }),
    );
    const drafts = Object.fromEntries(questions.map((question) => [
      question.id,
      { mode: "option" as const, value: "é".repeat(remoteInteractionAnswerCharacters) },
    ]));
    expect(interactionAnswersAreComplete(questions, drafts)).toBe(false);
    expect(buildInteractionAnswers(questions, drafts)).toBeNull();
  });

  test("preserves a provider question id that shadows an object prototype key", () => {
    const question: CompactRemoteInteractionQuestion = {
      ...closedChoice,
      id: "__proto__",
      options: [{ description: "Safe", label: "safe" }],
    };
    const drafts = Object.fromEntries([
      ["__proto__", { mode: "option" as const, value: "safe" }],
    ]);
    const answers = buildInteractionAnswers([question], drafts);
    expect(answers).not.toBeNull();
    expect(Object.keys(answers ?? {})).toEqual(["__proto__"]);
    expect(answers?.__proto__).toEqual({ answers: ["safe"] });
  });

  test("retries only terminal commands known not to have applied an effect", () => {
    for (const state of ["failed", "cancelled", "expired"]) {
      expect(interactionCommandAllowsRetry(state)).toBe(true);
    }
    for (const state of [
      undefined,
      "pending",
      "prepared",
      "effect_started",
      "applied",
      "ambiguous",
    ]) expect(interactionCommandAllowsRetry(state)).toBe(false);
  });
});
