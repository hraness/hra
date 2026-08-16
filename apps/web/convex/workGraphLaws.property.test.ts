import { describe, expect, test } from "bun:test";

import {
  blockerContribution,
  reviewActorAllowed,
  transitionSubmissionLifecycle,
  transitionBlockerCounters,
  validateDependencyInsertion,
  validateParentInsertion,
  type BlockerLifecycle,
} from "./workGraphLaws";

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state ^ (state >>> 15), 2_246_822_519) + 3_266_489_917) >>> 0;
    return state;
  };
}

describe("work graph properties", () => {
  test("every generated DAG path rejects its reverse closing edge", () => {
    for (let seed = 1; seed <= 250; seed += 1) {
      const next = generator(seed);
      const nodeCount = 3 + (next() % 40);
      const graph = new Map<string, string[]>();
      for (let node = 0; node < nodeCount; node += 1) graph.set(String(node), []);
      for (let left = 0; left < nodeCount - 1; left += 1) {
        const maximumJump = nodeCount - left - 1;
        const right = left + 1 + (next() % maximumJump);
        graph.get(String(left))?.push(String(right));
        expect(validateDependencyInsertion(graph, String(left), String(right)).kind).toBe("valid");
      }
      for (let node = 0; node < nodeCount - 1; node += 1) {
        graph.get(String(node))?.push(String(node + 1));
      }
      expect(validateDependencyInsertion(graph, String(nodeCount - 1), "0").kind).toBe("cycle");
    }
  });

  test("arbitrary blocker lifecycle walks preserve exact contributions", () => {
    const statuses: readonly BlockerLifecycle[] = [
      "open",
      "in_progress",
      "in_review",
      "done",
      "cancelled",
    ];
    for (let seed = 1; seed <= 500; seed += 1) {
      const next = generator(seed * 17);
      let status = statuses[next() % statuses.length] ?? "open";
      let counters = blockerContribution(status);
      for (let step = 0; step < 100; step += 1) {
        const following = statuses[next() % statuses.length] ?? "open";
        counters = transitionBlockerCounters(counters, status, following);
        expect(counters).toEqual(blockerContribution(following));
        status = following;
      }
    }
  });

  test("generated parent chains accept ancestors and reject closing cycles", () => {
    for (let length = 2; length <= 100; length += 1) {
      const parents = new Map<string, string | undefined>();
      for (let node = 0; node < length - 1; node += 1) {
        parents.set(String(node), String(node + 1));
      }
      parents.set(String(length - 1), undefined);
      expect(validateParentInsertion(parents, "new", "0").kind).toBe("valid");
      expect(validateParentInsertion(parents, String(length - 1), "0").kind).toBe("cycle");
    }
  });

  test("submission terminals stay immutable for arbitrary command walks", () => {
    const commands = ["accept", "reject", "cancel"] as const;
    for (let seed = 1; seed <= 500; seed += 1) {
      const next = generator(seed * 97);
      const first = commands[next() % commands.length] ?? "accept";
      const terminal = transitionSubmissionLifecycle("pending", first);
      expect(terminal).not.toBeNull();
      if (terminal === null) continue;
      for (let step = 0; step < 30; step += 1) {
        const command = commands[next() % commands.length] ?? "accept";
        expect(transitionSubmissionLifecycle(terminal, command)).toBeNull();
      }
      const submittedBy = `agt_${next()}`;
      expect(reviewActorAllowed({ submittedByAgentId: submittedBy, reviewerAgentId: submittedBy })).toBeFalse();
    }
  });
});
