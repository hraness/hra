// Regenerates src/domain/session-state.fixture.json from a private labelled
// corpus that never enters the repository. Each fixture row keeps only the
// SHA-256 of the message, its length, the hand label, and what the current
// classifier says, so a rule change shows up as a diff without exposing text.
//
//   bun ./scripts/session-state-fixture.ts --corpus <dir>
//
// The corpus directory holds hand45a.json and hand45b.json (arrays of rows
// with a `msg` string) and hand_labels.json (a map from label letter to row
// indexes into the concatenation of both arrays). Labels: A approval,
// B question, C blocked on a human action, D still working, E clean,
// F followups, G caveats or failure.
//
// The script refuses to write when any human-action row (C) classifies as
// needs_approval, because that is the one misclassification an autoresponder
// would turn into fabricated consent.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import {
  classifySessionState,
  type SessionState,
  type SessionStateRule,
} from "../src/domain/session-state";

const rowSchema = z.object({ msg: z.string() }).passthrough();
const labelsSchema = z.record(z.string().regex(/^[A-G]$/u), z.array(z.number().int().nonnegative()));

export const HAND_LABEL_TO_STATES: Readonly<Record<string, readonly SessionState[]>> = {
  A: ["needs_approval"],
  B: ["needs_answer"],
  C: ["needs_action", "needs_answer"],
  D: ["working"],
  E: ["done"],
  F: ["done_followups"],
  G: ["done_caveats", "aborted"],
};

export type SessionStateFixtureRow = Readonly<{
  sha256: string;
  length: number;
  label: string;
  classified: SessionState;
  matchedRule: SessionStateRule;
}>;

export type SessionStateFixture = Readonly<{
  generatedFrom: "private-corpus";
  rows: readonly SessionStateFixtureRow[];
  vectorDigest: string;
}>;

export function fixtureVectorDigest(rows: readonly SessionStateFixtureRow[]): string {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(`${row.sha256}:${row.classified}:${row.matchedRule}\n`);
  return hash.digest("hex");
}

export function summarize(rows: readonly SessionStateFixtureRow[]): Readonly<{
  agreement: number;
  attentionRecall: number;
  humanActionAsApproval: number;
  total: number;
}> {
  let agree = 0;
  let attentionTotal = 0;
  let attentionHit = 0;
  let humanActionAsApproval = 0;
  for (const row of rows) {
    const expected = HAND_LABEL_TO_STATES[row.label] ?? [];
    if (expected.includes(row.classified)) agree += 1;
    if (row.label === "A" || row.label === "B" || row.label === "C" || row.label === "D") {
      attentionTotal += 1;
      if (expected.includes(row.classified)) attentionHit += 1;
    }
    if (row.label === "C" && row.classified === "needs_approval") humanActionAsApproval += 1;
  }
  return {
    agreement: rows.length === 0 ? 0 : agree / rows.length,
    attentionRecall: attentionTotal === 0 ? 0 : attentionHit / attentionTotal,
    humanActionAsApproval,
    total: rows.length,
  };
}

if (import.meta.main) {
  const index = process.argv.indexOf("--corpus");
  const corpus = index === -1 ? undefined : process.argv[index + 1];
  if (corpus === undefined) {
    process.stderr.write("usage: bun ./scripts/session-state-fixture.ts --corpus <dir>\n");
    process.exit(2);
  }
  const rowsA = z.array(rowSchema).parse(JSON.parse(await readFile(join(corpus, "hand45a.json"), "utf8")));
  const rowsB = z.array(rowSchema).parse(JSON.parse(await readFile(join(corpus, "hand45b.json"), "utf8")));
  const labels = labelsSchema.parse(JSON.parse(await readFile(join(corpus, "hand_labels.json"), "utf8")));
  const all = [...rowsA, ...rowsB];
  const labelOf = new Map<number, string>();
  for (const [label, indexes] of Object.entries(labels)) {
    for (const rowIndex of indexes) labelOf.set(rowIndex, label);
  }
  const rows: SessionStateFixtureRow[] = [];
  for (const [rowIndex, row] of all.entries()) {
    const label = labelOf.get(rowIndex);
    if (label === undefined) continue;
    const classification = classifySessionState({
      finalAssistantText: row.msg,
      providerTurnStatus: "completed",
    });
    rows.push({
      sha256: createHash("sha256").update(row.msg).digest("hex"),
      length: row.msg.length,
      label,
      classified: classification.state,
      matchedRule: classification.matchedRule,
    });
  }
  const summary = summarize(rows);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.humanActionAsApproval > 0) {
    process.stderr.write("Refusing to write: a human-action row classifies as needs_approval.\n");
    process.exit(1);
  }
  const fixture: SessionStateFixture = {
    generatedFrom: "private-corpus",
    rows,
    vectorDigest: fixtureVectorDigest(rows),
  };
  const target = resolve(import.meta.dir, "..", "src", "domain", "session-state.fixture.json");
  await writeFile(target, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(`wrote ${target} (${String(rows.length)} rows)\n`);
}
