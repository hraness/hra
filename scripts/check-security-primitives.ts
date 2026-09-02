// Counts load-bearing security primitives per non-test source file and
// compares them to the reviewed table in scripts/security-primitives.json.
// A count that changes without a table edit fails the gate, so a refactor
// that silently drops a timing-safe compare, an O_NOFOLLOW open, an fsync,
// a mode check, a fence assertion, or a redaction site is caught before merge.
//
// Usage:
//   bun ./scripts/check-security-primitives.ts            compare and exit 1 on drift
//   bun ./scripts/check-security-primitives.ts --update   rewrite the table after review

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";

export const securityPrimitivePatterns: Readonly<Record<string, RegExp>> = {
  timingSafeEqual: /timingSafeEqual\(/gu,
  O_NOFOLLOW: /O_NOFOLLOW/gu,
  fsync: /\bfsync/gu,
  mode0600: /0o600/gu,
  mode0700: /0o700/gu,
  validateOwnedFile: /validateOwnedFile\(/gu,
  assertFence: /#assertFence\(/gu,
  assertCurrent: /assertCurrent\(/gu,
  immediateTransaction: /\.immediate\(\)/gu,
  secureDelete: /secure_delete/gu,
  synchronousFull: /synchronous\s*=?\s*["']?FULL/gu,
  safeEnvironmentKeys: /SAFE_ENVIRONMENT_KEYS/gu,
  redactCompleteSensitiveText: /redactCompleteSensitiveText\(/gu,
};

const scannedRoots = ["src", "convex"] as const;
const tablePath = "scripts/security-primitives.json";
const maximumFileBytes = 4 * 1024 * 1024;

const tableSchema = z.record(z.string().min(1).max(200), z.record(z.string().min(1).max(64), z.number().int().nonnegative()));
export type SecurityPrimitiveTable = z.infer<typeof tableSchema>;

async function listSourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "_generated") continue;
        await walk(path);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".setup.ts")) {
        files.push(path);
      }
    }
  };
  await walk(root);
  return files;
}

export async function countSecurityPrimitives(repositoryRoot: string): Promise<SecurityPrimitiveTable> {
  const table: Record<string, Record<string, number>> = {};
  for (const root of scannedRoots) {
    for (const file of await listSourceFiles(join(repositoryRoot, root))) {
      const text = await readFile(file, "utf8");
      if (Buffer.byteLength(text) > maximumFileBytes) throw new Error(`Refusing to scan oversized source file: ${relative(repositoryRoot, file)}`);
      const counts: Record<string, number> = {};
      for (const [name, pattern] of Object.entries(securityPrimitivePatterns)) {
        const count = text.match(pattern)?.length ?? 0;
        if (count > 0) counts[name] = count;
      }
      if (Object.keys(counts).length > 0) table[relative(repositoryRoot, file)] = counts;
    }
  }
  return table;
}

export function diffSecurityPrimitives(expected: SecurityPrimitiveTable, actual: SecurityPrimitiveTable): string[] {
  const lines: string[] = [];
  const files = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const file of [...files].sort()) {
    const before = expected[file] ?? {};
    const after = actual[file] ?? {};
    for (const name of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      const was = before[name] ?? 0;
      const now = after[name] ?? 0;
      if (was !== now) lines.push(`${file}: ${name} expected ${String(was)}, found ${String(now)}`);
    }
  }
  return lines;
}

export async function readSecurityPrimitiveTable(repositoryRoot: string): Promise<SecurityPrimitiveTable> {
  return tableSchema.parse(JSON.parse(await readFile(join(repositoryRoot, tablePath), "utf8")) as unknown);
}

if (import.meta.main) {
  const repositoryRoot = process.cwd();
  const actual = await countSecurityPrimitives(repositoryRoot);
  if (process.argv.includes("--update")) {
    await writeFile(join(repositoryRoot, tablePath), `${JSON.stringify(actual, null, 2)}\n`);
    process.stdout.write(`Wrote ${tablePath} for ${String(Object.keys(actual).length)} files.\n`);
  } else {
    const expected = await readSecurityPrimitiveTable(repositoryRoot);
    const drift = diffSecurityPrimitives(expected, actual);
    if (drift.length > 0) {
      process.stderr.write(`Security primitive counts drifted from ${tablePath}. Review each line, then run this script with --update if the change is intended.\n`);
      for (const line of drift) process.stderr.write(`  ${line}\n`);
      process.exit(1);
    }
    process.stdout.write(`Security primitive counts match ${tablePath} (${String(Object.keys(expected).length)} files).\n`);
  }
}
