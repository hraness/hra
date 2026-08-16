import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { compareForkHistory, summarizeObservedMessages } from "./scenarios";

test("probe executables use HRA current identities while retaining released evidence domains", async () => {
  const [scenariosSource, standaloneSource] = await Promise.all([
    readFile(new URL("./scenarios.ts", import.meta.url), "utf8"),
    readFile(new URL("./standalone-command.ts", import.meta.url), "utf8"),
  ]);

  expect(scenariosSource).toContain('name: "hra_phase1_probe"');
  expect(scenariosSource).toContain('title: "HRA Phase 1 Probe"');
  expect(scenariosSource).toContain('clientUserMessageId: `hra-phase1-');
  expect(scenariosSource).toContain('clientUserMessageId: `hra-dynamic-tool-');
  expect(scenariosSource).toMatch(/`hra-\$\{name\}-`/u);
  expect(scenariosSource).toMatch(/`\$\{canonicalTemp\}\/hra-`/u);
  expect(standaloneSource).toContain('name: "hra-probe"');
  expect(standaloneSource).toContain('title: "HRA protocol probe"');
  expect(scenariosSource).toContain('kind: "oprte.phase1.codex-protocol-evidence"');
  expect(scenariosSource).toContain('kind: "oprte.codex.dynamic-tool.real-probe-observations"');
  expect(scenariosSource).toContain('namespace: "oprte"');
  expect(scenariosSource).toContain("oprte/rlm_run");
});

describe("pending replay diagnostics", () => {
  test("summarizes methods and request ids without retaining params", () => {
    const summary = summarizeObservedMessages([
      {
        ordinal: 4,
        receivedAtMs: 10,
        value: {
          method: "turn/started",
          params: { threadId: "thread-secret", prompt: "not retained" },
        },
      },
      {
        ordinal: 5,
        receivedAtMs: 11,
        value: {
          id: "request-1",
          method: "item/tool/requestUserInput",
          params: { questions: [{ id: "secret", header: "not retained" }] },
        },
      },
    ]);

    expect(summary).toEqual([
      { ordinal: 4, method: "turn/started", kind: "notification" },
      {
        ordinal: 5,
        method: "item/tool/requestUserInput",
        kind: "server-request",
        requestId: "request-1",
      },
    ]);
    expect(JSON.stringify(summary)).not.toContain("thread-secret");
    expect(JSON.stringify(summary)).not.toContain("not retained");
  });

  test("bounds evidence to the latest forty protocol messages", () => {
    const messages = Array.from({ length: 45 }, (_unused, index) => ({
      ordinal: index + 1,
      receivedAtMs: index,
      value: { method: `fixture/${String(index + 1)}` },
    }));

    const summary = summarizeObservedMessages(messages);
    expect(summary).toHaveLength(40);
    expect(summary[0]).toMatchObject({ ordinal: 6, method: "fixture/6" });
  });
});

describe("fork semantic history", () => {
  test("accepts rekeyed items and lossy reasoning when visible messages are unchanged", () => {
    const source = [
      {
        id: "source-turn",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "source-user",
            clientId: "source-client",
            content: [{ type: "text", text: "hello", text_elements: [] }],
          },
          { type: "reasoning", id: "source-reasoning", summary: ["private"], content: [] },
          {
            type: "agentMessage",
            id: "source-agent",
            text: "world",
            phase: "final_answer",
          },
        ],
      },
    ];
    const promoted = [
      {
        id: "promoted-turn",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "promoted-user",
            clientId: "promoted-client",
            content: [{ type: "text", text: "hello", text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "promoted-agent",
            text: "world",
            phase: null,
          },
        ],
      },
    ];

    const comparison = compareForkHistory(source, promoted);
    expect(comparison.turnShapeMatched).toBe(true);
    expect(comparison.visibleHistoryMatched).toBe(true);
    expect(comparison.identityPayloadMatched).toBe(false);
    expect(comparison.sourceItemCount).toBe(3);
    expect(comparison.promotedItemCount).toBe(2);
  });

  test("rejects changed visible assistant content", () => {
    const source = [
      {
        id: "source-turn",
        status: "completed",
        items: [{ type: "agentMessage", id: "a", text: "original" }],
      },
    ];
    const promoted = [
      {
        id: "promoted-turn",
        status: "completed",
        items: [{ type: "agentMessage", id: "b", text: "changed" }],
      },
    ];

    expect(compareForkHistory(source, promoted).visibleHistoryMatched).toBe(false);
  });

  test("distinguishes an empty stored source from an empty promoted projection", () => {
    const emptySource = compareForkHistory(
      [{ id: "source", status: "completed", items: [] }],
      [
        {
          id: "promoted",
          status: "completed",
          items: [{ type: "agentMessage", id: "a", text: "visible" }],
        },
      ],
    );
    expect(emptySource.sourceVisibleMessageCount).toBe(0);
    expect(emptySource.promotedVisibleMessageCount).toBe(1);

    const emptyPromoted = compareForkHistory(
      [
        {
          id: "source",
          status: "completed",
          items: [{ type: "agentMessage", id: "a", text: "visible" }],
        },
      ],
      [{ id: "promoted", status: "completed", items: [] }],
    );
    expect(emptyPromoted.sourceVisibleMessageCount).toBe(1);
    expect(emptyPromoted.promotedVisibleMessageCount).toBe(0);
  });
});
