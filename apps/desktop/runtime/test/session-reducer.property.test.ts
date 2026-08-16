import { expect, test } from "bun:test";

import type { CodexFact } from "../src/codex";
import { createSessionState, reduceSessionFact, reduceSessionFacts } from "../src/sessions/reducer";
import { createSessionSelectors } from "../src/sessions/selectors";

const accountProfileId = "acct_property_fixture";

function base(position: number, generation = 1) {
  return {
    accountProfileId,
    encodedBytes: 64,
    factIndex: 0,
    generation,
    origin: "live" as const,
    streamPosition: position,
  };
}

function initialFacts(): CodexFact[] {
  return [{
    ...base(1),
    type: "thread.snapshot",
    origin: "snapshot",
    thread: {
      archived: false,
      createdAt: "2026-07-29T00:00:00.000Z",
      cwd: "/fixture",
      id: "thread",
      status: "active",
      title: null,
      turns: [{
        completedAt: null,
        id: "turn",
        items: [],
        startedAt: "2026-07-29T00:00:01.000Z",
        status: "active",
      }],
      updatedAt: "2026-07-29T00:00:01.000Z",
    },
  }, {
    ...base(2),
    type: "item.started",
    activity: null,
    itemId: "item",
    kind: "assistant_text",
    threadId: "thread",
    turnId: "turn",
  }];
}

test("arbitrary adjacent streaming fragments preserve order, multiplicity, and replay determinism", () => {
  const selectors = createSessionSelectors();
  for (let seed = 1; seed <= 128; seed += 1) {
    let random = seed;
    const fragments: string[] = [];
    const facts = initialFacts();
    for (let index = 0; index < 64; index += 1) {
      random = (random * 48_271) % 2_147_483_647;
      const fragment = random % 5 === 0
        ? "same"
        : String.fromCodePoint(97 + (random % 26));
      fragments.push(fragment);
      facts.push({
        ...base(index + 3),
        type: "item.delta",
        channel: "assistant_text",
        delta: fragment,
        itemId: "item",
        threadId: "thread",
        truncated: false,
        turnId: "turn",
      });
    }
    const state = reduceSessionFacts(createSessionState(), facts);
    expect(selectors.selectItem(state, accountProfileId, "item")?.text)
      .toBe(fragments.join(""));
    expect(reduceSessionFacts(createSessionState(), facts)).toEqual(state);
    expect(reduceSessionFacts(
      createSessionState(),
      facts.flatMap((fact) => [fact, fact]),
    )).toEqual(state);

    let replayed = createSessionState();
    for (const fact of facts) {
      replayed = reduceSessionFact(replayed, fact);
      const afterDuplicate = reduceSessionFact(replayed, fact);
      expect(afterDuplicate).toBe(replayed);
    }
    expect(selectors.selectItem(replayed, accountProfileId, "item")?.text)
      .toBe(fragments.join(""));
    expect({ ...replayed, revision: state.revision }).toEqual(state);
  }
});

test("every older generation is noninterfering regardless of its stream position", () => {
  let state = reduceSessionFacts(createSessionState(), [{
    ...base(1, 7),
    type: "thread.snapshot",
    origin: "snapshot",
    thread: {
      archived: false,
      createdAt: "2026-07-29T00:00:00.000Z",
      cwd: "/fixture",
      id: "thread",
      status: "idle",
      title: "Current",
      turns: null,
      updatedAt: "2026-07-29T00:00:00.000Z",
    },
  }]);
  for (let generation = 1; generation < 7; generation += 1) {
    for (const position of [1, 10, 1_000, Number.MAX_SAFE_INTEGER]) {
      const stale = reduceSessionFact(state, {
        ...base(position, generation),
        type: "thread.title_changed",
        threadId: "thread",
        title: `stale-${String(generation)}-${String(position)}`,
      });
      expect(stale).toBe(state);
      state = stale;
    }
  }
});

test("mixed-account out-of-order batches equal sequential folding modulo revision", () => {
  const facts: CodexFact[] = [
    {
      ...base(4, 2),
      type: "runtime.changed",
      availability: "running",
    },
    {
      ...base(10),
      accountProfileId: "acct_property_fixture_b",
      type: "account.changed",
      availability: "signed_in",
    },
    {
      ...base(3, 2),
      type: "runtime.changed",
      availability: "backoff",
    },
    {
      ...base(1, 2),
      accountProfileId: "acct_property_fixture_b",
      type: "account.changed",
      availability: "signed_out",
    },
    {
      ...base(1, 3),
      type: "account.changed",
      availability: "signed_in",
    },
    {
      ...base(Number.MAX_SAFE_INTEGER),
      accountProfileId: "acct_property_fixture_b",
      type: "runtime.changed",
      availability: "failed",
    },
  ];
  const batched = reduceSessionFacts(createSessionState(), facts);
  let sequential = createSessionState();
  for (const fact of facts) sequential = reduceSessionFact(sequential, fact);

  expect({ ...sequential, revision: batched.revision }).toEqual(batched);
});
