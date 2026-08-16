import path from "node:path";

export const DIRECT_WIRE_MARKERS = Object.freeze([
  "direct.browser-bridge/",
  "direct.coverage/",
  "direct.fixture/",
  "direct.probe/",
  "direct.runtime/",
  "direct.session-manifest/",
] as const);

export interface BundleBoundaryViolation {
  readonly file: string;
  readonly markers: readonly string[];
}

export interface BundleBoundaryResult {
  readonly scanned: readonly string[];
  readonly violations: readonly BundleBoundaryViolation[];
}

export interface BundleBoundaryOptions {
  readonly directory: string;
  readonly excludePatterns?: readonly string[];
  readonly markers: readonly string[];
  readonly patterns: readonly string[];
}

export interface ExactVersionedMarkerEvidence {
  readonly missing: readonly string[];
  readonly observed: readonly string[];
  readonly unexpected: readonly string[];
}

function validatedMarkers(markers: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const marker of markers) {
    if (marker.length === 0) throw new Error("Bundle-boundary markers cannot be empty.");
    if (seen.has(marker)) throw new Error(`Bundle-boundary marker is duplicated: ${marker}`);
    seen.add(marker);
    output.push(marker);
  }
  if (output.length === 0) throw new Error("A bundle boundary needs at least one forbidden marker.");
  return Object.freeze(output);
}

function validatedPatterns(patterns: readonly string[]): readonly string[] {
  if (patterns.length === 0) throw new Error("A bundle boundary needs at least one file pattern.");
  return Object.freeze(patterns.map((pattern) => {
    if (pattern.length === 0) throw new Error("Bundle-boundary file patterns cannot be empty.");
    return pattern;
  }));
}

function validatedExcludePatterns(patterns: readonly string[] | undefined): readonly string[] {
  return Object.freeze((patterns ?? []).map((pattern) => {
    if (pattern.length === 0) throw new Error("Bundle-boundary exclusion patterns cannot be empty.");
    return pattern;
  }));
}

function versionedMarkerFamilies(
  expectedMarkers: readonly string[],
): readonly { readonly expected: string; readonly family: string }[] {
  if (expectedMarkers.length === 0) {
    throw new Error("An exact versioned-marker policy needs at least one expected marker.");
  }
  const seen = new Set<string>();
  return Object.freeze(expectedMarkers.map((expected) => {
    const match = /^(?<family>[A-Za-z0-9][A-Za-z0-9._/-]*\/v)(?<version>0|[1-9][0-9]*)$/u
      .exec(expected);
    const family = match?.groups?.["family"];
    if (family === undefined) {
      throw new Error(`Exact versioned marker must end in a canonical numeric version: ${expected}`);
    }
    if (seen.has(family)) {
      throw new Error(`Exact versioned-marker family is duplicated: ${family}`);
    }
    seen.add(family);
    return Object.freeze({ expected, family });
  }));
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function inspectExactVersionedMarkers(
  byteSequences: Iterable<Uint8Array>,
  expectedMarkers: readonly string[],
): ExactVersionedMarkerEvidence {
  const families = versionedMarkerFamilies(expectedMarkers);
  const observed = new Set<string>();
  const contents = [...byteSequences].map((bytes) => (
    Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1")
  ));
  for (const { family } of families) {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9._/-])${escapedRegExp(family)}[0-9]+(?![A-Za-z0-9._/-])`,
      "gu",
    );
    for (const content of contents) {
      for (const match of content.matchAll(pattern)) observed.add(match[0]);
    }
  }
  const expected = new Set(expectedMarkers);
  const matching = expectedMarkers.filter((marker) => observed.has(marker));
  const unexpected = [...observed]
    .filter((marker) => !expected.has(marker))
    .sort((left, right) => left.localeCompare(right));
  return Object.freeze({
    missing: Object.freeze(expectedMarkers.filter((marker) => !observed.has(marker))),
    observed: Object.freeze([...matching, ...unexpected]),
    unexpected: Object.freeze(unexpected),
  });
}

export function findForbiddenMarkers(
  bytes: Uint8Array,
  markers: readonly string[],
): readonly string[] {
  const contents = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return validatedMarkers(markers).filter((marker) => contents.includes(Buffer.from(marker)));
}

export async function checkBundleBoundary(
  options: BundleBoundaryOptions,
): Promise<BundleBoundaryResult> {
  const root = path.resolve(options.directory);
  const markers = validatedMarkers(options.markers);
  const patterns = validatedPatterns(options.patterns);
  const excludePatterns = validatedExcludePatterns(options.excludePatterns)
    .map((pattern) => new Bun.Glob(pattern));
  const scanned = new Set<string>();
  const violations: BundleBoundaryViolation[] = [];

  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    for await (const relative of glob.scan({ cwd: root, dot: true, onlyFiles: true })) {
      if (excludePatterns.some((excludePattern) => excludePattern.match(relative))) continue;
      const file = path.join(root, relative);
      if (scanned.has(file)) continue;
      scanned.add(file);
      const found = findForbiddenMarkers(
        new Uint8Array(await Bun.file(file).arrayBuffer()),
        markers,
      );
      if (found.length > 0) violations.push({ file, markers: found });
    }
  }

  return {
    scanned: Object.freeze([...scanned].sort()),
    violations: Object.freeze(violations.toSorted((left, right) => left.file.localeCompare(right.file))),
  };
}
