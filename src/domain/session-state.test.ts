import { describe, expect, test } from "bun:test";

import {
  classifySessionState,
  prepareAssistantText,
  requiresHumanInput,
  SESSION_STATES,
  type SessionState,
} from "./session-state";
import fixtureJson from "./session-state.fixture.json";
import {
  fixtureVectorDigest,
  HAND_LABEL_TO_STATES,
  summarize,
  type SessionStateFixture,
} from "../../scripts/session-state-fixture";

const fixture = fixtureJson as SessionStateFixture;

const completed = (text: string) => classifySessionState({
  finalAssistantText: text,
  providerTurnStatus: "completed",
});

describe("session state classifier", () => {
  test("aborted and failed turns win over any text", () => {
    for (const status of ["interrupted", "failed"] as const) {
      const result = classifySessionState({
        finalAssistantText: "Please approve the deployment.",
        providerTurnStatus: status,
      });
      expect(result).toMatchObject({ state: "aborted", attention: false, matchedRule: "provider_status" });
    }
  });

  test("pending provider interactions decide by kind and by the user-interaction flag", () => {
    expect(classifySessionState({
      finalAssistantText: "",
      providerTurnStatus: "completed",
      pendingInteraction: { kind: "command_approval" },
    })).toMatchObject({ state: "needs_approval", attention: false, matchedRule: "pending_interaction" });
    expect(classifySessionState({
      finalAssistantText: "",
      providerTurnStatus: "completed",
      pendingInteraction: { kind: "command_approval" },
      autorespondWillAct: false,
    })).toMatchObject({ state: "needs_approval", attention: true });
    expect(classifySessionState({
      finalAssistantText: "",
      providerTurnStatus: "completed",
      pendingInteraction: { kind: "permission_approval", requiresUserInteraction: true },
    })).toMatchObject({ state: "needs_answer", attention: true });
    for (const kind of ["user_input", "mcp_elicitation"] as const) {
      expect(classifySessionState({
        finalAssistantText: "",
        providerTurnStatus: "completed",
        pendingInteraction: { kind },
      })).toMatchObject({ state: "needs_answer", attention: true });
    }
  });

  test("human-action cues beat approval cues, so a login ask never becomes consent", () => {
    const login = completed(
      "The publish step is staged. Please authorize the release once you log in to npm on your phone and paste the one-time code here.",
    );
    expect(login).toMatchObject({ state: "needs_action", attention: true, matchedRule: "human_action_cue" });
    const phone = completed("Everything is ready. Approve the pairing request on your phone, then tell me when it shows connected.");
    expect(phone.state).toBe("needs_action");
    const code = completed("I requested the code. Paste the verification code from your email and I will finish sign-in.");
    expect(code.state).toBe("needs_action");
  });

  test("approval asks classify as needs_approval and detect verbatim literals", () => {
    const plain = completed("The migration is prepared and nothing has run yet. Do you approve running it against staging now?");
    expect(plain).toMatchObject({ state: "needs_approval", attention: false, verbatimRequired: false, matchedRule: "approval_cue" });
    const verbatim = completed([
      "Sending the 100 contacts externally needs your explicit approval.",
      "",
      "Please reply:",
      "",
      "> I approve sending the selected contacts for enrichment.",
      "",
      "No job has launched yet.",
    ].join("\n"));
    expect(verbatim).toMatchObject({
      state: "needs_approval",
      verbatimRequired: true,
      verbatimLiteral: "I approve sending the selected contacts for enrichment.",
    });
    const quoted = completed('Ready to apply. Reply with "go ahead" and I will push the branch.');
    expect(quoted).toMatchObject({ state: "needs_approval", verbatimRequired: true, verbatimLiteral: "go ahead" });
    expect(completed("Shall I proceed with the rename across the three packages?").state).toBe("needs_approval");
    expect(completed("Awaiting your go-ahead before I delete the old worktrees.").state).toBe("needs_approval");
  });

  test("denylist cues demote an approval ask to needs_answer", () => {
    const payment = completed("The invoice is drafted. Do you approve charging the credit card on file for the $400 balance?");
    expect(payment).toMatchObject({ state: "needs_answer", attention: true, matchedRule: "denylist_cue" });
    const email = completed("Draft ready. Should I proceed and send the email to the vendor's support address?");
    expect(email.state).toBe("needs_answer");
    const mention = completed("Password verification worked and the hourly monitor is active again.");
    expect(mention.state).toBe("working");
  });

  test("a trailing question without approval framing needs an answer", () => {
    const question = completed("Both layouts pass the tests. Which one do you prefer for the mobile breakpoint?");
    expect(question).toMatchObject({ state: "needs_answer", attention: true, matchedRule: "trailing_question" });
  });

  test("progress cues, open subagents, and armed monitors keep the session working", () => {
    expect(completed("No LinkedIn archive notification yet. Nothing was opened or changed; hourly monitoring continues.").state).toBe("working");
    expect(completed("Set. I’ll remind you here at 10:00 when the delay ends.").state).toBe("working");
    expect(classifySessionState({ finalAssistantText: "Fanned out three reviewers.", providerTurnStatus: "completed", openSubagents: 2 }))
      .toMatchObject({ state: "working", reason: "open subagents" });
    expect(classifySessionState({ finalAssistantText: "Watcher armed.", providerTurnStatus: "completed", armedMonitor: true }).state)
      .toBe("working");
  });

  test("failure verdicts, followups, and clean completions", () => {
    expect(completed("NO-GO. Blocking findings: the checksum test still fails on Linux and the release is not releasable yet.")).toMatchObject({ state: "done_caveats", matchedRule: "failure_cue" });
    expect(completed("Done. Recommended next steps: wire the alias move and add a smoke test; I can prepare both in parallel.")).toMatchObject({ state: "done_followups", matchedRule: "followup_cue" });
    expect(completed("Done. 152 tests, lint, type-check, and build all pass. No commit created.")).toMatchObject({ state: "done", attention: false, matchedRule: "default_done" });
  });

  test("fenced code and blockquotes never supply cues", () => {
    const text = [
      "Implemented the runbook.",
      "",
      "```sh",
      "echo 'reply with approve'",
      "```",
      "",
      "> Historical note: the old flow said please approve before deploying.",
      "",
      "Nothing else changed.",
    ].join("\n");
    expect(completed(text).state).toBe("done");
    const prepared = prepareAssistantText(text);
    expect(prepared.tail).not.toContain("please approve");
    expect(prepared.literals).toContain("Historical note: the old flow said please approve before deploying.");
  });

  test("the tail is bounded and long messages are truncated safely", () => {
    const long = `${"x".repeat(70_000)}\n\nDo you approve?`;
    expect(completed(long).state).toBe("needs_approval");
    expect(prepareAssistantText(long).tail.length).toBeLessThanOrEqual(600);
  });

  test("states and human-input predicate are closed", () => {
    for (const state of SESSION_STATES) {
      expect(requiresHumanInput(state)).toBe(["needs_approval", "needs_answer", "needs_action"].includes(state));
    }
  });
});

describe("session state corpus fixture", () => {
  const rows = fixture.rows;

  test("the committed vector digest matches the rows", () => {
    expect(fixture.generatedFrom).toBe("private-corpus");
    expect(rows.length).toBeGreaterThanOrEqual(80);
    expect(fixtureVectorDigest(rows)).toBe(fixture.vectorDigest);
    for (const row of rows) {
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(SESSION_STATES).toContain(row.classified as SessionState);
      expect(Object.keys(HAND_LABEL_TO_STATES)).toContain(row.label);
    }
  });

  test("no human-action row classifies as an approval, and recall on attention classes holds", () => {
    const summary = summarize(rows);
    expect(summary.humanActionAsApproval).toBe(0);
    expect(summary.attentionRecall).toBeGreaterThanOrEqual(0.9);
    expect(summary.agreement).toBeGreaterThanOrEqual(0.75);
  });

  test("clean completions rarely trigger an approval", () => {
    const clean = rows.filter((row) => row.label === "E");
    const falseApprovals = clean.filter((row) => row.classified === "needs_approval").length;
    expect(falseApprovals / clean.length).toBeLessThanOrEqual(0.05);
  });
});
