import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SubagentChips } from "./subagent-chips";
import type { SubagentChipInput } from "../model/session-view";

/*
 * The derivation is proven in `model/session-view.test.ts`. This proves what
 * the card actually emits: nothing at all without a subagent, and never a style
 * attribute, which `style-src 'self'` would refuse.
 */
const render = (subagents: readonly SubagentChipInput[]): string =>
  renderToStaticMarkup(<SubagentChips sessionTitle="Session" subagents={subagents} />);

const agent = (
  agentId: string,
  overrides: Partial<SubagentChipInput> = {},
): SubagentChipInput => ({ agentId, depth: 1, nickname: null, role: null, ...overrides });

describe("subagent chips", () => {
  test("a session with no subagents renders nothing", () => {
    expect(render([])).toBe("");
  });

  test("names each chip and carries the role and depth for a hover", () => {
    const markup = render([agent("a", { depth: 2, nickname: "Scout", role: "reviewer" })]);
    expect(markup).toContain("Scout");
    expect(markup).toContain("reviewer · depth 2");
  });

  test("counts the ones beyond three", () => {
    const markup = render([
      agent("a", { nickname: "one" }),
      agent("b", { nickname: "two" }),
      agent("c", { nickname: "three" }),
      agent("d", { nickname: "four" }),
      agent("e", { nickname: "five" }),
    ]);
    expect(markup).toContain("+2");
    // Three faces by code point order, and the rest behind the count.
    expect(markup).toContain(">five<");
    expect(markup).not.toContain(">three<");
    expect(markup).not.toContain(">two<");
  });

  test("sets no style attribute", () => {
    expect(render([agent("a", { nickname: "Scout" })])).not.toContain("style=");
  });
});
