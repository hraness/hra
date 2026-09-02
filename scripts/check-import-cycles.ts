import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Static file-level import graph over one source root. Only relative
// specifiers count; packages and Bun builtins are outside the graph.
const specifierPattern =
  /(?:^|\n)\s*(?:import|export)\b[^;'"]*?from\s*["'](\.[^"']*)["']|(?:^|\n)\s*import\s*["'](\.[^"']*)["']|\bimport\(\s*["'](\.[^"']*)["']\s*\)/gu;
const maximumFiles = 5_000;
const maximumFileBytes = 4 * 1024 * 1024;

export type ImportGraph = ReadonlyMap<string, readonly string[]>;

export function collectImportGraph(root: string): ImportGraph {
  const absoluteRoot = resolve(root);
  const files = listTypeScriptFiles(absoluteRoot);
  const known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const edges = new Set<string>();
    for (const match of source.matchAll(specifierPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier === undefined) continue;
      const target = resolveModule(dirname(file), specifier, known);
      if (target !== null && target !== file) edges.add(target);
    }
    graph.set(relative(absoluteRoot, file), [...edges].map((edge) => relative(absoluteRoot, edge)).sort());
  }
  return graph;
}

export function findImportCycles(graph: ImportGraph): readonly (readonly string[])[] {
  // Tarjan strongly connected components. Iterative so a deep chain cannot
  // overflow the stack.
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let nextIndex = 0;

  for (const start of [...graph.keys()].sort()) {
    if (index.has(start)) continue;
    const work: { node: string; edges: readonly string[]; position: number }[] = [];
    visit(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      if (frame.position < frame.edges.length) {
        const next = frame.edges[frame.position];
        frame.position += 1;
        if (next === undefined || !graph.has(next)) continue;
        if (!index.has(next)) {
          visit(next);
        } else if (onStack.has(next)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node) ?? 0, index.get(next) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node) ?? 0, lowLink.get(frame.node) ?? 0));
      }
      if (lowLink.get(frame.node) !== index.get(frame.node)) continue;
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.node);
      if (component.length > 1) cycles.push(component.sort());
    }

    function visit(node: string): void {
      index.set(node, nextIndex);
      lowLink.set(node, nextIndex);
      nextIndex += 1;
      stack.push(node);
      onStack.add(node);
      work.push({ node, edges: graph.get(node) ?? [], position: 0 });
    }
  }
  return cycles.sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
}

function listTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") pending.push(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      if (statSync(path).size > maximumFileBytes) {
        throw new Error(`Refusing to scan a source file over ${maximumFileBytes} bytes.`);
      }
      files.push(path);
      if (files.length > maximumFiles) {
        throw new Error(`Refusing to scan more than ${maximumFiles} source files.`);
      }
    }
  }
  return files.sort();
}

function resolveModule(fromDirectory: string, specifier: string, known: ReadonlySet<string>): string | null {
  const base = resolve(fromDirectory, specifier);
  const candidates = [
    base,
    `${base}.ts`,
    join(base, "index.ts"),
    base.replace(/\.js$/u, ".ts"),
  ];
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

if (import.meta.main) {
  const root = process.argv[2] ?? join(import.meta.dirname, "..", "src");
  const cycles = findImportCycles(collectImportGraph(root));
  if (cycles.length === 0) {
    process.stdout.write(`No file-level import cycles under ${relative(process.cwd(), root) || "."}.\n`);
  } else {
    process.stderr.write(`${cycles.length} import cycle(s) found:\n`);
    for (const cycle of cycles) process.stderr.write(`  ${cycle.join(" <-> ")}\n`);
    process.exit(1);
  }
}
