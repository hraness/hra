import { describe, expect, test } from "bun:test";

import { assertLiveReleaseRepository } from "./release-repository-identity";

const exact = Object.freeze({
  default_branch: "main",
  full_name: "hraness/hra",
  id: 1_343_008_607,
  owner: { id: 307_125_679 },
  private: false,
  visibility: "public",
});

describe("live release repository identity", () => {
  test("admits only the exact public repository", () => {
    expect(() => assertLiveReleaseRepository(exact)).not.toThrow();
    for (const drift of [
      { private: true, visibility: "private" },
      { id: 7 },
      { owner: { id: 7 } },
      { default_branch: "release" },
      { full_name: "attacker/hra" },
    ]) {
      expect(() => assertLiveReleaseRepository({ ...exact, ...drift }))
        .toThrow("exact live public HRA repository identity");
    }
  });
});
