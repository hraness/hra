import { describe, expect, test } from "bun:test";

import { agentGuideErrors } from "./check-agent-guides";

describe("standalone agent guides", () => {
  test("accepts only the two required populated sections", () => {
    expect(agentGuideErrors([
      {
        path: "AGENTS.md",
        source: "# Contents\n\n- `apps/` – applications.\n\n# Guidelines\n\n- Keep boundaries local.\n",
      },
      {
        path: "apps/AGENTS.md",
        source: "# Contents\n\n- `web/` – web.\n\n# Guidelines\n\n- Keep it checked.\n",
      },
    ])).toEqual([]);
  });

  test("rejects missing, renamed, reordered, empty, and duplicate guides", () => {
    expect(agentGuideErrors([
      {
        path: "docs/GUIDE.md",
        source: "# Contents\n\n- docs\n\n# Guidelines\n\n- rules\n",
      },
      {
        path: "apps/AGENTS.md",
        source: "# Guidelines\n\n- rules\n\n# Contents\n\n- apps\n",
      },
      {
        path: "empty/AGENTS.md",
        source: "# Contents\n\n# Guidelines\n",
      },
      {
        path: "empty/AGENTS.md",
        source: "# Contents\n\n- duplicate\n\n# Guidelines\n\n- duplicate\n",
      },
    ])).toEqual([
      "apps/AGENTS.md: must contain exactly # Contents then # Guidelines",
      "docs/GUIDE.md: agent guide must be named AGENTS.md",
      "empty/AGENTS.md: Contents must include at least one list item",
      "empty/AGENTS.md: Guidelines must include at least one list item",
      "empty/AGENTS.md: duplicate agent guide",
      "AGENTS.md: root agent guide is missing",
    ]);
  });
});
