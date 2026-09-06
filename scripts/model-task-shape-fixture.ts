// Generates the content-free model-task-shape regression fixture from one
// explicitly named private JSON file. The source text is parsed in memory and
// is never copied, hashed, measured, logged, or placed in the fixture.
//
//   bun ./scripts/model-task-shape-fixture.ts --corpus /absolute/path/corpus.json
//
// The input document is `{ "version": 1, "rows": [...] }`. Each strict row
// carries an opaque UUID case id, taskText, a hand label, and a case kind.

import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import {
  classifyModelTaskShape,
  MODEL_TASK_SHAPE_MAX_BYTES,
  modelTaskShapeRuleSchema,
  modelTaskShapeSchema,
  type ModelTaskShape,
  type ModelTaskShapeRule,
} from "../src/domain/model-task-shape";

export const MODEL_TASK_SHAPE_CASE_KINDS = [
  "ordinary",
  "empty",
  "hostile",
  "ambiguous",
  "conflicting",
  "reported_text",
] as const;

export const modelTaskShapeCaseKindSchema = z.enum(MODEL_TASK_SHAPE_CASE_KINDS);
export type ModelTaskShapeCaseKind = z.infer<typeof modelTaskShapeCaseKindSchema>;

export const MODEL_TASK_SHAPE_FIXTURE_SOURCES = [
  "synthetic-cases",
  "explicit-private-corpus",
] as const;

export const modelTaskShapeFixtureSourceSchema = z.enum(MODEL_TASK_SHAPE_FIXTURE_SOURCES);
export type ModelTaskShapeFixtureSource =
  z.infer<typeof modelTaskShapeFixtureSourceSchema>;

const opaqueCaseIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  "caseId must be an opaque UUIDv4",
);

const privateCorpusRowSchema = z.object({
  caseId: opaqueCaseIdSchema,
  caseKind: modelTaskShapeCaseKindSchema,
  label: modelTaskShapeSchema,
  taskText: z.string().max(MODEL_TASK_SHAPE_MAX_BYTES + 1),
}).strict();

export const modelTaskShapePrivateCorpusSchema = z.object({
  rows: z.array(privateCorpusRowSchema).min(1).max(4_096),
  version: z.literal(1),
}).strict();

export type ModelTaskShapeFixtureRow = Readonly<{
  caseId: string;
  caseKind: ModelTaskShapeCaseKind;
  label: ModelTaskShape;
  classified: ModelTaskShape;
  matchedRule: ModelTaskShapeRule;
}>;

const modelTaskShapeFixtureRowSchema = z.object({
  caseId: opaqueCaseIdSchema,
  caseKind: modelTaskShapeCaseKindSchema,
  classified: modelTaskShapeSchema,
  label: modelTaskShapeSchema,
  matchedRule: modelTaskShapeRuleSchema,
}).strict();

export const modelTaskShapeFixtureSchema = z.object({
  generatedFrom: modelTaskShapeFixtureSourceSchema,
  rows: z.array(modelTaskShapeFixtureRowSchema).min(1),
  vectorDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  version: z.literal(1),
}).strict();

export type ModelTaskShapeFixture = z.infer<typeof modelTaskShapeFixtureSchema>;

export function modelTaskShapeFixtureVectorDigest(
  rows: readonly ModelTaskShapeFixtureRow[],
): string {
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(JSON.stringify([
      row.caseId,
      row.label,
      row.caseKind,
      row.classified,
      row.matchedRule,
    ]));
    hash.update("\n");
  }
  return hash.digest("hex");
}

const refusalMessage =
  "Refusing to write: an unsafe case classified as well_defined.";

export function buildModelTaskShapeFixture(
  input: unknown,
  generatedFrom: ModelTaskShapeFixtureSource,
): ModelTaskShapeFixture {
  const corpus = modelTaskShapePrivateCorpusSchema.parse(input);
  const ids = new Set<string>();
  const rows: ModelTaskShapeFixtureRow[] = [];

  for (const row of corpus.rows) {
    if (ids.has(row.caseId)) throw new Error("Refusing to write: duplicate caseId.");
    ids.add(row.caseId);
    const classification = classifyModelTaskShape({ taskText: row.taskText });
    const failClosedCase = row.caseKind === "ambiguous"
      || row.caseKind === "conflicting"
      || row.caseKind === "empty"
      || row.caseKind === "hostile";
    if (failClosedCase && row.label === "well_defined") {
      throw new Error("Refusing to write: a fail-closed case is labelled well_defined.");
    }
    if (
      classification.shape === "well_defined"
      && row.label !== "well_defined"
    ) {
      throw new Error(refusalMessage);
    }
    rows.push({
      caseId: row.caseId,
      caseKind: row.caseKind,
      classified: classification.shape,
      label: row.label,
      matchedRule: classification.matchedRule,
    });
  }

  return modelTaskShapeFixtureSchema.parse({
    generatedFrom,
    rows,
    vectorDigest: modelTaskShapeFixtureVectorDigest(rows),
    version: 1,
  });
}

export type ModelTaskShapeFixtureSummary = Readonly<{
  agreementRate: number;
  classified: Readonly<Record<ModelTaskShape, number>>;
  total: number;
}>;

export function summarizeModelTaskShapeFixture(
  fixture: ModelTaskShapeFixture,
): ModelTaskShapeFixtureSummary {
  const classified: Record<ModelTaskShape, number> = {
    mechanical: 0,
    open_ended: 0,
    uncertain: 0,
    well_defined: 0,
  };
  let agreements = 0;
  for (const row of fixture.rows) {
    classified[row.classified] += 1;
    if (row.classified === row.label) agreements += 1;
  }
  return {
    agreementRate: agreements / fixture.rows.length,
    classified,
    total: fixture.rows.length,
  };
}

export function parseModelTaskShapeCorpusArgument(argv: readonly string[]): string {
  if (
    argv.length !== 2
    || argv[0] !== "--corpus"
    || argv[1] === undefined
    || !isAbsolute(argv[1])
  ) {
    throw new Error(
      "usage: bun ./scripts/model-task-shape-fixture.ts --corpus <absolute-json-path>",
    );
  }
  return argv[1];
}

const fixturePath = resolve(
  import.meta.dir,
  "..",
  "src",
  "domain",
  "model-task-shape.fixture.json",
);

const MODEL_TASK_SHAPE_CORPUS_MAX_BYTES = 16 * 1_024 * 1_024;

async function readExplicitCorpus(corpusPath: string): Promise<unknown> {
  const handle = await open(corpusPath, "r");
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MODEL_TASK_SHAPE_CORPUS_MAX_BYTES) {
      throw new Error("corpus is not one bounded regular file");
    }
    const bytes = Buffer.alloc(MODEL_TASK_SHAPE_CORPUS_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (bytesRead > MODEL_TASK_SHAPE_CORPUS_MAX_BYTES) {
      throw new Error("corpus too large");
    }
    const source = new TextDecoder("utf-8", { fatal: true })
      .decode(bytes.subarray(0, bytesRead));
    return JSON.parse(source) as unknown;
  } finally {
    await handle.close();
  }
}

async function generateModelTaskShapeFixture(argv: readonly string[]): Promise<void> {
  const corpusPath = parseModelTaskShapeCorpusArgument(argv);
  let input: unknown;
  try {
    input = await readExplicitCorpus(corpusPath);
  } catch {
    throw new Error("Refusing to write: the explicit corpus could not be read as JSON.");
  }
  const fixture = buildModelTaskShapeFixture(input, "explicit-private-corpus");
  await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summarizeModelTaskShapeFixture(fixture))}\n`);
}

if (import.meta.main) {
  try {
    await generateModelTaskShapeFixture(process.argv.slice(2));
  } catch (error: unknown) {
    const message = error instanceof Error && error.message.startsWith("usage:")
      ? error.message
      : error instanceof Error && error.message.startsWith("Refusing to write:")
        ? error.message
        : "Refusing to write: the explicit corpus is invalid.";
    process.stderr.write(`${message}\n`);
    process.exitCode = message.startsWith("usage:") ? 2 : 1;
  }
}
