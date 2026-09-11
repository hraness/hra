import { createHash } from "node:crypto";

import { z } from "zod";

const outputSchema = z.strictObject({ exitCode: z.literal(0), stderr: z.literal(""), stdout: z.string().max(16 * 1024)
  .refine((value) => value.length <= 16 * 1024 && !/\p{Cc}/u.test(value.replaceAll("\n", ""))) });

export class ClaudeAuthHelpError extends Error {
  constructor() { super("CLAUDE_AUTH_HELP_REFUSED"); this.name = "ClaudeAuthHelpError"; }
}

function parseOutput(input: unknown): string {
  const parsed = outputSchema.safeParse(input);
  if (!parsed.success) throw new ClaudeAuthHelpError();
  return parsed.data.stdout;
}
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Preserves the existing logout acceptance grammar, including bounded descriptive prose. */
export function parseClaudeAuthLogoutHelp(input: unknown): string {
  const stdout = parseOutput(input);
  const normalized = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
  const nonempty = normalized.split("\n").map((line, index) => ({ index, value: line.trim() })).filter((line) => line.value.length > 0);
  const usage = nonempty[0];
  const options = nonempty.filter((line) => line.value === "Options:");
  const optionsLine = options[0];
  const optionLines = optionsLine === undefined ? [] : nonempty.filter((line) => line.index > optionsLine.index);
  if (usage?.value !== "Usage: claude auth logout [options]" || options.length !== 1 || optionsLine === undefined
    || optionLines.length !== 1 || !/^-h, +--help(?: {2,}[^\r\n]+)?$/u.test(optionLines[0]?.value ?? "")) throw new ClaudeAuthHelpError();
  return digest(stdout);
}

type UnverifiedOptionRow = Readonly<{ flags: readonly string[]; argument: "none" | "required" | "optional" }>;
function unverifiedOptionRows(stdout: string): Readonly<{ optionRows: readonly UnverifiedOptionRow[]; projectionComplete: boolean }> {
  const lines = stdout.split("\n");
  if (lines.length > 256) return Object.freeze({ optionRows: Object.freeze([]), projectionComplete: false });
  const headings = lines.flatMap((line, index) => line.trim() === "Options:" ? [index] : []);
  const heading = headings[0];
  if (headings.length !== 1 || heading === undefined) return Object.freeze({ optionRows: Object.freeze([]), projectionComplete: false });
  const rows: UnverifiedOptionRow[] = []; const seen = new Set<string>(); let complete = true; let candidates = 0;
  for (const line of lines.slice(heading + 1)) {
    if (line.trim() === "") continue;
    candidates += 1;
    if (candidates > 32) { complete = false; continue; }
    // Descriptions and placeholder names are never projected. The declaration
    // grammar only classifies bounded flag tokens and an argument's shape.
    const declaration = line.trim().split(/ {2,}/u)[0] ?? "";
    if (declaration.length > 256) { complete = false; continue; }
    const matched = /^(?:(-[A-Za-z0-9]), +)?(--[a-z][a-z0-9-]{0,63})(?: +(<[A-Za-z][A-Za-z0-9_-]{0,63}>|\[[A-Za-z][A-Za-z0-9_-]{0,63}\]))?$/u.exec(declaration);
    const long = matched?.[2];
    if (matched === null || long === undefined) { complete = false; continue; }
    const flags = matched[1] === undefined ? [long] : [matched[1], long];
    if (flags.some((flag) => seen.has(flag))) { complete = false; continue; }
    for (const flag of flags) seen.add(flag);
    const argument = matched[3] === undefined ? "none" : matched[3].startsWith("<") ? "required" : "optional";
    rows.push(Object.freeze({ flags: Object.freeze(flags), argument }));
  }
  return Object.freeze({ optionRows: Object.freeze(rows), projectionComplete: complete && rows.length > 0 });
}

/** Private bounded diagnostic only. Projection completeness is extraction, never capability acceptance. */
export function inspectClaudeAuthLoginHelp(input: unknown): Readonly<{ admitted: false; reason: "login_help_unverified"; helpSha256: string;
  optionRows: readonly UnverifiedOptionRow[]; projectionComplete: boolean }> {
  const stdout = parseOutput(input);
  if (stdout.trim().length === 0) throw new ClaudeAuthHelpError();
  return Object.freeze({ admitted: false, reason: "login_help_unverified", helpSha256: digest(stdout), ...unverifiedOptionRows(stdout) });
}
