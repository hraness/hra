const MAX_SOURCE_ID_LENGTH = 512;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]*$/u;

export interface SourceCoordinate {
  readonly sourceId: string;
  readonly generation: number;
  readonly sequence: number;
  readonly index: number;
}

export type SourceCoordinateRelation =
  | "different-source"
  | "before"
  | "equal"
  | "after";

function assertNaturalNumber(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

function assertSourceId(sourceId: string): void {
  if (
    sourceId.length === 0 ||
    sourceId.length > MAX_SOURCE_ID_LENGTH ||
    !SOURCE_ID_PATTERN.test(sourceId)
  ) {
    throw new RangeError(
      `sourceId must contain 1 to ${String(MAX_SOURCE_ID_LENGTH)} portable identifier characters`,
    );
  }
}

export function createSourceCoordinate(
  coordinate: SourceCoordinate,
): SourceCoordinate {
  assertSourceId(coordinate.sourceId);
  assertNaturalNumber(coordinate.generation, "generation");
  assertNaturalNumber(coordinate.sequence, "sequence");
  assertNaturalNumber(coordinate.index, "index");
  return Object.freeze({ ...coordinate });
}

export function compareSourceCoordinates(
  left: SourceCoordinate,
  right: SourceCoordinate,
): SourceCoordinateRelation {
  if (left.sourceId !== right.sourceId) return "different-source";

  const fields = ["generation", "sequence", "index"] as const;
  for (const field of fields) {
    if (left[field] < right[field]) return "before";
    if (left[field] > right[field]) return "after";
  }
  return "equal";
}

export function isSourceCoordinateCurrent(
  candidate: SourceCoordinate,
  floor: SourceCoordinate,
): boolean {
  const relation = compareSourceCoordinates(candidate, floor);
  return relation === "equal" || relation === "after";
}
